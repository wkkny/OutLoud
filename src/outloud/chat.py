import asyncio
import json
import logging
import time
import sqlite3
import uuid
from dataclasses import dataclass, field
from contextlib import contextmanager
from typing import Literal

import anyio
import httpx2
from pydantic import BaseModel, Field, model_validator
from .study_coach import StudyReply, SYSTEM_PROMPT, assessment_result

logger = logging.getLogger(__name__)
MODEL = "gemma3:4b"
CONTEXT_TOKENS = 4096
MAX_INPUT_CHARACTERS = 12000


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=65536)


class ChatRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    study_action: Literal['answer', 'explain', 'practice', 'finish'] = 'answer'
    messages: list[ChatMessage] = Field(min_length=1, max_length=65)

    @model_validator(mode="after")
    def valid_turns(self):
        if len(self.messages) % 2 != 1:
            raise ValueError("Messages must end with a user turn")
        for index, message in enumerate(self.messages):
            if message.role == "user" and len(message.content) > MAX_INPUT_CHARACTERS:
                raise ValueError("User messages cannot exceed 12,000 characters")
            if message.role != ("user" if index % 2 == 0 else "assistant") or not message.content.strip():
                raise ValueError("Messages must alternate nonempty user and assistant turns")
        return self

    def context(self):
        selected = [self.messages[-1]]
        size = len(selected[0].content)
        for index in range(len(self.messages) - 3, -1, -2):
            pair = self.messages[index:index + 2]
            added = sum(len(message.content) for message in pair)
            if size + added > MAX_INPUT_CHARACTERS:
                break
            selected[0:0] = pair
            size += added
        return [message.model_dump() for message in selected]


class ChatBusy(RuntimeError):
    pass


class ChatCapacityBusy(RuntimeError):
    pass


class ChatFailure(RuntimeError):
    pass


def ollama_client():
    return httpx2.AsyncClient(
        base_url="http://127.0.0.1:11434", trust_env=False,
        timeout=httpx2.Timeout(connect=3, read=60, write=5, pool=5),
    )


async def drain(operation):
    """Wait without forwarding response-scope or repeated task cancellation."""
    interrupted = False
    with anyio.CancelScope(shield=True):
        while True:
            try:
                result = await asyncio.shield(operation)
                break
            except asyncio.CancelledError:
                if operation.cancelled():
                    raise
                interrupted = True
    if interrupted:
        raise asyncio.CancelledError
    return result


@dataclass
class Generation:
    session_id: str
    request: ChatRequest
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=16))
    task: asyncio.Task | None = None
    finalizing: bool = False
    abandoned: bool = False

    def cancel(self):
        # Once finalization starts, completion is irrevocable. An explicit Stop
        # reports inactive and must not drop deltas from a successful response.
        if self.finalizing or self.task.done():
            return False
        if not self.task.cancelling():
            self.task.cancel()
        return True

    def abandon(self):
        # Only a disconnected stream or shutdown abandons queued output. Drain it
        # without interrupting a durable final write or blocking terminal delivery.
        self.abandoned = True
        while not self.queue.empty():
            self.queue.get_nowait()
        self.cancel()

    def event(self, kind, **data):
        return {"type": f"chat.{kind}", "request_id": self.request.request_id, **data}


class Chat:
    """Conversation-scoped generations with a bounded app-wide concurrency limit."""

    def __init__(self, client_factory=None, *, store=None, max_concurrent=2, on_change=None):
        if type(max_concurrent) is not int or max_concurrent < 1:
            raise ValueError("max_concurrent must be a positive integer")
        self.client_factory = client_factory or ollama_client
        self.store = store
        self.study = None
        self.on_change = on_change or (lambda conversation_id: None)
        self.max_concurrent = max_concurrent
        self.active = {}
        self.model_reservations = 0

    @contextmanager
    def reserve_model(self):
        self.check_capacity()
        self.model_reservations += 1
        try:
            yield
        finally:
            self.model_reservations -= 1

    def check_capacity(self):
        if len(self.active) + self.model_reservations >= self.max_concurrent:
            raise ChatCapacityBusy('Gemma is busy. Wait for a reply or extraction to finish, then retry.')

    def start(self, session_id, request):
        if request.conversation_id in self.active:
            raise ChatBusy("This conversation is already generating a reply. Stop it or wait, then try again.")
        self.check_capacity()
        generation = Generation(session_id, request)
        self.active[request.conversation_id] = generation
        generation.task = asyncio.create_task(self.generate(generation))

        def finished(task):
            if self.active.get(generation.request.conversation_id) is generation:
                del self.active[generation.request.conversation_id]
            # Cancellation before the coroutine's first instruction never enters
            # its finally block. Still release ownership and finish the stream.
            if task.cancelled():
                while not generation.queue.empty():
                    generation.queue.get_nowait()
                generation.queue.put_nowait(generation.event("cancelled"))

        generation.task.add_done_callback(finished)
        return generation

    def cancel(self, session_id, request_id=None):
        matches = [generation for generation in self.active.values()
                   if generation.session_id == session_id and
                   (request_id is None or generation.request.request_id == request_id)]
        cancelled = False
        for generation in matches:
            cancelled = generation.cancel() or cancelled
        return cancelled

    def cancel_conversation(self, conversation_id):
        generation = self.active.get(conversation_id)
        if generation is not None:
            generation.cancel()

    async def close(self):
        generations = list(self.active.values())
        for generation in generations:
            generation.abandon()
        if generations:
            await drain(asyncio.gather(*(generation.task for generation in generations), return_exceptions=True))

    async def storage(self, method, *args):
        # Cancellation cannot stop sqlite3 in a worker thread. Drain the operation
        # before releasing the conversation slot, so a retry sees committed state.
        operation = asyncio.create_task(asyncio.to_thread(method, *args))
        return await drain(operation)

    async def generate(self, generation):
        started = time.monotonic()
        terminal = generation.event("error", message="Ollama ended without a complete reply.")
        turn_id = str(uuid.uuid4())
        turn_started = False
        reply = ""
        study_plan, study_result = None, None
        action = generation.request.study_action
        try:
            if self.store is not None:
                saved = await self.storage(self.store.request_messages, generation.request.conversation_id, generation.request.request_id)
                if saved:
                    terminal = await self.replay(generation, saved)
                    return
                history = await self.storage(self.store.context, generation.request.conversation_id)
                # Only the latest user turn comes from the browser. Stored complete
                # turns are authoritative; a stale/forged client history is ignored.
                generation.request = ChatRequest(
                    request_id=generation.request.request_id,
                    conversation_id=generation.request.conversation_id,
                    messages=[*history, generation.request.messages[-1]], study_action=action,
                )
            payload = {"model": MODEL, "messages": generation.request.context(), "stream": True,
                       "options": {"num_ctx": CONTEXT_TOKENS, "num_predict": 1024}, "keep_alive": "2m"}
            if self.study is not None:
                study_plan = await self.storage(self.study.prepare, generation.request.conversation_id, action)
            if study_plan is not None:
                payload['messages'] = [{'role': 'system', 'content': SYSTEM_PROMPT}, {'role': 'user', 'content': json.dumps({key: value for key, value in {**study_plan, 'latest_answer': generation.request.messages[-1].content}.items() if key not in ('conversation_id', 'topic_id', 'previous_evidence')}, ensure_ascii=False)}]
                payload['format'] = StudyReply.model_json_schema()
                payload['options']['temperature'] = 0
                # Save a reviewed study answer before waiting for model feedback.
                inserted = await self.storage(self.store.start_turn, generation.request.conversation_id, turn_id, generation.request.messages[-1].content, generation.request.request_id, lambda: self.study.begin_attempt(study_plan))
                if not inserted:
                    terminal = await self.replay(generation, await self.storage(self.store.request_messages, generation.request.conversation_id, generation.request.request_id))
                    return
                turn_started = True
                self.on_change(generation.request.conversation_id)
                await generation.queue.put(generation.event('started', model=MODEL, context_tokens=CONTEXT_TOKENS))
            async with asyncio.timeout(180), self.client_factory() as client:
                async with client.stream("POST", "/api/chat", json=payload) as response:
                    if response.status_code == 404:
                        raise ChatFailure("Gemma is not installed. Run: ollama pull gemma3:4b")
                    if response.status_code != 200:
                        raise ChatFailure("Ollama could not start generation. Check its terminal and try again.")
                    accepted = study_plan is not None
                    characters = 0
                    first_token = None
                    leading = ""
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        if len(line) > 262144:
                            raise ChatFailure("Ollama returned an oversized response.")
                        packet = json.loads(line)
                        if not isinstance(packet, dict) or packet.get("error"):
                            raise ChatFailure("Ollama could not generate a reply. Check its terminal and try again.")
                        message = packet.get("message")
                        if not isinstance(message, dict) or type(packet.get("done")) is not bool:
                            raise ChatFailure("Ollama returned an invalid response.")
                        text = message.get("content")
                        if not isinstance(text, str):
                            raise ChatFailure("Ollama returned an invalid response.")
                        if text:
                            characters += len(text)
                            if characters > 65536:
                                raise ChatFailure("Gemma's reply exceeded the output limit.")
                            if not accepted:
                                leading += text
                                if leading.strip():
                                    if self.store is not None:
                                        turn_started = True
                                        inserted = await self.storage(self.store.start_turn, generation.request.conversation_id, turn_id, generation.request.messages[-1].content, generation.request.request_id)
                                        if not inserted:
                                            turn_started = False
                                            saved = await self.storage(self.store.request_messages, generation.request.conversation_id, generation.request.request_id)
                                            terminal = await self.replay(generation, saved)
                                            return
                                        self.on_change(generation.request.conversation_id)
                                    await generation.queue.put(generation.event("started", model=MODEL, context_tokens=CONTEXT_TOKENS))
                                    accepted = True
                                    text, leading = leading, ""
                            if accepted:
                                if first_token is None:
                                    first_token = time.monotonic() - started
                                reply += text
                                if study_plan is None:
                                    await generation.queue.put(generation.event("delta", text=text))
                        if packet.get("done") is True:
                            if not accepted:
                                raise ChatFailure("Gemma returned an empty reply. Try again.")
                            if study_plan is not None:
                                if packet.get('done_reason') == 'length':
                                    raise ChatFailure('Study feedback was incomplete. Retry with a shorter answer.')
                                study_result = assessment_result(study_plan, reply)
                                reply = study_result['rendered']
                                await generation.queue.put(generation.event('delta', text=reply))
                            metrics = {"elapsed_seconds": time.monotonic() - started, "first_token_seconds": first_token}
                            for source, target, divisor in (
                                ("eval_count", "output_tokens", 1), ("prompt_eval_count", "input_tokens", 1),
                                ("total_duration", "total_seconds", 1e9), ("load_duration", "load_seconds", 1e9),
                                ("eval_duration", "generation_seconds", 1e9),
                            ):
                                value = packet.get(source)
                                if type(value) is int and value >= 0:
                                    metrics[target] = value / divisor if divisor != 1 else value
                            terminal = generation.event("done", metrics=metrics)
                            break
        except asyncio.CancelledError:
            terminal = generation.event("cancelled")
        except (httpx2.TimeoutException, TimeoutError):
            terminal = generation.event("error", message="Ollama took too long to respond. Try again or restart Ollama.")
        except httpx2.ConnectError:
            terminal = generation.event("error", message="Cannot reach Ollama. Start it with: ollama serve")
        except LookupError:
            terminal = generation.event("error", message="Conversation was deleted. Create or select another chat.")
        except sqlite3.OperationalError:
            terminal = generation.event("error", message="Local conversation storage is busy or unavailable. Try again.")
        except ChatFailure as error:
            terminal = generation.event("error", message=str(error))
        except (httpx2.HTTPError, ValueError):
            terminal = generation.event("error", message="Ollama returned an invalid or interrupted response. Try again.")
        except Exception:
            logger.exception("Unexpected chat failure")
            terminal = generation.event("error", message="Chat failed. Check the backend terminal and try again.")
        finally:
            generation.finalizing = True
            if turn_started:
                status = {"chat.done": "complete", "chat.cancelled": "cancelled"}.get(terminal["type"], "failed")
                try:
                    callback = (lambda user_id: self.study.complete(study_plan, study_result, user_id)) if study_result is not None else None
                    if study_plan is not None and study_result is None:
                        reply = ''  # Never persist malformed JSON as user-visible feedback.
                    await self.storage(self.store.finish_turn, generation.request.conversation_id, turn_id, reply, status, terminal.get("metrics"), callback)
                    self.on_change(generation.request.conversation_id)
                except asyncio.CancelledError:
                    # The drain completed its transaction before propagating this
                    # cancellation. Preserve the already-decided terminal result.
                    pass
                except sqlite3.Error:
                    logger.exception("Could not persist chat result")
                    terminal = generation.event("error", message="The reply could not be saved locally. Check storage and try again.")
            # Preserve queued deltas on ordinary completion/error. Cancellation
            # drops only unsent chunks so a stopped reply cannot keep streaming.
            if terminal["type"] == "chat.cancelled" or generation.abandoned:
                while not generation.queue.empty():
                    generation.queue.get_nowait()
            await generation.queue.put(terminal)

    async def replay(self, generation, messages):
        """A lost acceptance may be retried, but must never create another turn."""
        user, assistant = messages
        if user["content"] != generation.request.messages[-1].content:
            raise ChatFailure("This request was already used for a different message.")
        await generation.queue.put(generation.event("started", model=MODEL, context_tokens=CONTEXT_TOKENS))
        if assistant["content"]:
            await generation.queue.put(generation.event("delta", text=assistant["content"]))
        if assistant["status"] == "complete":
            return generation.event("done", metrics=assistant["metrics"] or {"elapsed_seconds": 0})
        # Recovery confirms the saved user turn without automatically generating
        # a second answer to a previously accepted, interrupted request.
        return generation.event("error", message="This message was already saved. Its partial reply has been kept.")

    async def stream(self, generation):
        try:
            while True:
                event = await generation.queue.get()
                yield json.dumps(event) + "\n"
                if event["type"] in ("chat.done", "chat.error", "chat.cancelled"):
                    return
        finally:
            generation.abandon()
            await drain(asyncio.gather(generation.task, return_exceptions=True))
