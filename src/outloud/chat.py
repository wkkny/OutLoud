import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Literal

import httpx2
from pydantic import BaseModel, Field, model_validator

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


class ChatFailure(RuntimeError):
    pass


def ollama_client():
    return httpx2.AsyncClient(
        base_url="http://127.0.0.1:11434", trust_env=False,
        timeout=httpx2.Timeout(connect=3, read=60, write=5, pool=5),
    )


@dataclass
class Generation:
    session_id: str
    request: ChatRequest
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=16))
    task: asyncio.Task | None = None

    def cancel(self):
        # HTTP abort, Stop, owner revocation, and shutdown can all race. A second
        # cancellation must not interrupt the first one's async HTTP cleanup.
        if not self.task.done() and not self.task.cancelling():
            self.task.cancel()

    def event(self, kind, **data):
        return {"type": f"chat.{kind}", "request_id": self.request.request_id, **data}


class Chat:
    """One owner-scoped generation, bounded streaming, and deliberate cancellation."""

    def __init__(self, client_factory=None):
        self.client_factory = client_factory or ollama_client
        self.active = None

    def start(self, session_id, request):
        if self.active is not None:
            raise ChatBusy("Gemma is already generating a reply. Stop it before sending again.")
        generation = Generation(session_id, request)
        self.active = generation
        generation.task = asyncio.create_task(self.generate(generation))

        def finished(task):
            if self.active is generation:
                self.active = None
            # Cancellation before the coroutine's first instruction never enters
            # its finally block. Still release ownership and finish the stream.
            if task.cancelled():
                while not generation.queue.empty():
                    generation.queue.get_nowait()
                generation.queue.put_nowait(generation.event("cancelled"))

        generation.task.add_done_callback(finished)
        return generation

    def cancel(self, session_id, request_id=None):
        generation = self.active
        if generation is None or generation.session_id != session_id:
            return False
        if request_id is not None and generation.request.request_id != request_id:
            return False
        generation.cancel()
        return True

    async def close(self):
        generation = self.active
        if generation is not None:
            generation.cancel()
            await asyncio.gather(generation.task, return_exceptions=True)

    async def generate(self, generation):
        started = time.monotonic()
        terminal = generation.event("error", message="Ollama ended without a complete reply.")
        try:
            async with asyncio.timeout(180), self.client_factory() as client:
                async with client.stream("POST", "/api/chat", json={
                    "model": MODEL, "messages": generation.request.context(), "stream": True,
                    "options": {"num_ctx": CONTEXT_TOKENS, "num_predict": 1024}, "keep_alive": "2m",
                }) as response:
                    if response.status_code == 404:
                        raise ChatFailure("Gemma is not installed. Run: ollama pull gemma3:4b")
                    if response.status_code != 200:
                        raise ChatFailure("Ollama could not start generation. Check its terminal and try again.")
                    accepted = False
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
                                    await generation.queue.put(generation.event("started", model=MODEL, context_tokens=CONTEXT_TOKENS))
                                    accepted = True
                                    text, leading = leading, ""
                            if accepted:
                                if first_token is None:
                                    first_token = time.monotonic() - started
                                await generation.queue.put(generation.event("delta", text=text))
                        if packet.get("done") is True:
                            if not accepted:
                                raise ChatFailure("Gemma returned an empty reply. Try again.")
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
        except ChatFailure as error:
            terminal = generation.event("error", message=str(error))
        except (httpx2.HTTPError, ValueError):
            terminal = generation.event("error", message="Ollama returned an invalid or interrupted response. Try again.")
        except Exception:
            logger.exception("Unexpected chat failure")
            terminal = generation.event("error", message="Chat failed. Check the backend terminal and try again.")
        finally:
            # Preserve queued deltas on ordinary completion/error. Cancellation
            # drops only unsent chunks so a stopped reply cannot keep streaming.
            if terminal["type"] == "chat.cancelled":
                while not generation.queue.empty():
                    generation.queue.get_nowait()
            await generation.queue.put(terminal)

    async def stream(self, generation):
        try:
            while True:
                event = await generation.queue.get()
                yield json.dumps(event) + "\n"
                if event["type"] in ("chat.done", "chat.error", "chat.cancelled"):
                    return
        finally:
            generation.cancel()
            await asyncio.gather(generation.task, return_exceptions=True)
