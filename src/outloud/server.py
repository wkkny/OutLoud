import asyncio
import itertools
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import time
from typing import Literal
from contextlib import asynccontextmanager

import anyio
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .runtime import RecordingRuntime, RecordingBusy, RuntimeUnavailable, is_valid_recording_level
from .capacity import CapacityUnavailable
from .chat import Chat, ChatBusy, ChatCapacityBusy, ChatRequest, drain
from .conversations import ConversationStore, DraftConflict
from .study import StudyStore
from .study_api import study_router
from .study_uploads import UploadExtractor

logger = logging.getLogger(__name__)

ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
}


class PressRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128)


class FnRequest(PressRequest):
    enabled: bool = Field(strict=True)


class ChatCancelRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)


class ConversationCreate(BaseModel):
    title: str = Field(default="New chat", min_length=1, max_length=200)
    subject_id: str | None = None
    mode: Literal["study", "chat"] = "chat"
    topic_ids: list[str] = Field(default_factory=list, max_length=200)
    focus_topic_id: str | None = None


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    draft: str | None = Field(default=None, max_length=65536)
    draft_version: int | None = Field(default=None, strict=True, ge=0)
    subject_id: str | None = None
    mode: Literal["study", "chat"] | None = None
    topic_ids: list[str] | None = Field(default=None, max_length=200)
    focus_topic_id: str | None = None


class Heartbeat(BaseModel):
    type: Literal["session.ping"]
    id: int = Field(strict=True, ge=0, le=9007199254740991)


class TranscriptAck(PressRequest):
    type: Literal["transcript.ack"]
    recording_id: str = Field(min_length=1, max_length=128)


client_message = TypeAdapter(Heartbeat | TranscriptAck)


class ClientConnection:
    def __init__(self, session_id, websocket, inbox, revoke, acknowledged, prepare_transcript, *, conversation_id=None, lease_seconds=90, clock=time.monotonic):
        self.session_id = session_id
        self.websocket = websocket
        self.inbox = inbox
        self.revoke = revoke
        self.acknowledged = acknowledged
        self.prepare_transcript = prepare_transcript
        self.conversation_id = conversation_id
        self.lease_seconds = lease_seconds
        self.clock = clock
        self.last_heartbeat = clock()
        self.active = True
        self.events = asyncio.Queue(maxsize=128)
        self.controls = asyncio.Queue(maxsize=128)
        self.acknowledgements = asyncio.Queue(maxsize=128)
        self.delivery_slots = asyncio.Semaphore(16)
        self.in_flight = set()
        self.send_lock = asyncio.Lock()
        self.ready_sent = asyncio.Event()
        self.transcripts_ready = asyncio.Event()
        self.transcripts_ready.set()
        self.pending_conversations = set()
        self.level_event = None
        self.level_ready = asyncio.Event()

    def alive(self):
        return self.active and self.clock() - self.last_heartbeat < self.lease_seconds

    def deliver(self, event):
        if not self.active:
            return
        if event["type"] == "recording.level":
            # A single replaceable slot keeps telemetry out of reliable queues.
            # Meter traffic must not revoke a client, including expired peers.
            if not self.alive() or event.get("session_id") != self.session_id or not is_valid_recording_level(event):
                return
            self.level_event = {"type": "recording.level", "recording_id": event["recording_id"],
                                "level": float(event["level"])}
            self.level_ready.set()
            return
        if event["type"] == "recording.state" and self.level_event is not None:
            if not event["recording"] or event.get("recording_id") != self.level_event["recording_id"]:
                self.level_event = None
                self.level_ready.clear()
        if not self.alive():
            self.revoke(self)
            return
        completed = event["type"] == "transcription.completed"
        if completed:
            if self.conversation_id is not None and event["conversation_id"] != self.conversation_id:
                return
            # The inbox already owns this result. Wake its bounded sender rather
            # than queueing a second copy while initial replay is still running.
            self.transcripts_ready.set()
            return
        elif event["type"] != "recording.state" and event.get("session_id") not in (None, self.session_id):
            return
        if event["type"] == "conversation.updated":
            conversation_id = event["conversation_id"]
            if conversation_id in self.pending_conversations:
                return
            self.pending_conversations.add(conversation_id)
        public_event = {key: value for key, value in event.items() if key != "session_id"}
        target = self.controls if event["type"] in ("session.pong", "pong", "transcript.acknowledged") else self.events
        try:
            target.put_nowait(public_event)
        except asyncio.QueueFull:
            # Revoke immediately, not after a potentially blocked socket send.
            self.revoke(self)
            for buffer in (self.events, self.controls):
                while not buffer.empty():
                    buffer.get_nowait()
            self.events.put_nowait({
                "type": "connection.error",
                "message": "Client could not keep up with events; reconnect.",
            })

    def release_delivery(self, recording_id):
        if recording_id in self.in_flight:
            self.in_flight.remove(recording_id)
            self.delivery_slots.release()

    async def send(self, event):
        if event["type"] == "transcription.completed":
            if not await self.prepare_transcript(event):
                return
            recording_id = event["recording_id"]
            if recording_id in self.in_flight:
                return
            await self.delivery_slots.acquire()
            self.in_flight.add(recording_id)
            # Replay/live delivery can race an earlier acknowledgement. Register
            # before the read so an intervening ack can release this credit.
            pending = await asyncio.to_thread(self.inbox.is_pending, recording_id)
            if not pending or not self.active or recording_id not in self.in_flight:
                self.release_delivery(recording_id)
                return
        async with self.send_lock:
            await self.websocket.send_json(event)
        # Keep receive/lease tasks responsive even if transport sends don't yield.
        await asyncio.sleep(0)

    async def send_controls(self):
        await self.ready_sent.wait()
        while True:
            await self.send(await self.controls.get())

    async def send_levels(self):
        await self.ready_sent.wait()
        while self.active:
            await self.level_ready.wait()
            async with self.send_lock:
                # Read only after the transport is available, so a slow send
                # cannot hold an obsolete sample ahead of the latest reading.
                event = self.level_event
                self.level_event = None
                self.level_ready.clear()
                if event is not None and self.active:
                    await self.websocket.send_json(event)
            await asyncio.sleep(0)

    async def send_events(self, state_snapshot):
        await self.send({
            "type": "session.ready", "session_id": self.session_id,
            "state": state_snapshot(self.session_id),
        })
        self.ready_sent.set()
        while True:
            event = await self.events.get()
            if event["type"] == "conversation.updated":
                self.pending_conversations.discard(event["conversation_id"])
            await self.send(event)
            if event["type"] == "connection.error":
                await self.websocket.close(code=1013)
                return

    async def send_transcripts(self):
        await self.ready_sent.wait()
        while self.active:
            await self.transcripts_ready.wait()
            self.transcripts_ready.clear()
            # Every scan has a finite high-water mark. Completions arriving during
            # it set the wakeup again, so later results get their own scan.
            replay = self.inbox.replay(self.conversation_id)
            while self.active:
                batch = await asyncio.to_thread(lambda: list(itertools.islice(replay, 16)))
                if not batch:
                    break
                for event in batch:
                    if not self.active:
                        return
                    try:
                        await self.send(event)
                    except sqlite3.Error:
                        # The inbox still owns this transcript. A failed draft
                        # write must not close the tab's event connection; a later
                        # reconnect/replay can commit it and notify this tab.
                        logger.exception('Could not recover transcript into saved draft')
                        self.deliver({'type': 'transcription.error', 'message': 'Transcript is saved but the draft could not be updated. Reconnect to retry.'})

    async def watch_lease(self):
        while True:
            remaining = self.lease_seconds - (self.clock() - self.last_heartbeat)
            if not self.active or remaining <= 0:
                self.revoke(self)
                await self.websocket.close(code=1001, reason="Owner heartbeat expired")
                return
            await asyncio.sleep(min(remaining, 1))

    async def process_acknowledgements(self):
        while True:
            parsed = await self.acknowledgements.get()
            if await asyncio.to_thread(self.inbox.acknowledge, parsed.recording_id, parsed.conversation_id):
                self.acknowledged(parsed.recording_id)
                self.deliver({
                    "type": "transcript.acknowledged", "recording_id": parsed.recording_id,
                    "conversation_id": parsed.conversation_id,
                })

    async def receive_messages(self):
        while True:
            try:
                message = await self.websocket.receive_text()
            except KeyError:  # A binary frame is not part of this protocol.
                self.revoke(self)
                await self.websocket.close(code=1003, reason="Text messages required")
                return
            if not self.alive():
                self.revoke(self)
                await self.websocket.close(code=1001, reason="Owner heartbeat expired")
                return
            if message == "ping":
                self.last_heartbeat = self.clock()
                self.deliver({"type": "pong"})
                continue
            try:
                parsed = client_message.validate_json(message)
            except ValidationError:
                self.revoke(self)
                await self.websocket.close(code=1003, reason="Invalid client message")
                return
            if isinstance(parsed, Heartbeat):
                self.last_heartbeat = self.clock()
                self.deliver({"type": "session.pong", "id": parsed.id})
            else:
                if self.conversation_id is not None and parsed.conversation_id != self.conversation_id:
                    self.revoke(self)
                    await self.websocket.close(code=1003, reason="Wrong acknowledgement conversation")
                    return
                try:
                    self.acknowledgements.put_nowait(parsed)
                except asyncio.QueueFull:
                    self.revoke(self)
                    await self.websocket.close(code=1013, reason="Acknowledgement backlog is full")
                    return


def production_runtime(publish):
    return RecordingRuntime(
        publish, max_transcriptions=int(os.environ.get("OUTLOUD_MAX_TRANSCRIPTIONS", "3")),
        delivery_path=Path("recordings/delivery.sqlite3"),
    )


def create_app(runtime_factory=None, *, owner_lease_seconds=90, clock=time.monotonic, ollama_client_factory=None, conversations_path=None, desktop_token=None, request_shutdown=None):
    allowed_origins = ALLOWED_ORIGINS | ({"http://127.0.0.1:5174"} if desktop_token is not None and request_shutdown is not None else set())
    production = runtime_factory is None
    runtime_factory = runtime_factory or production_runtime
    clients = {}
    loop = None
    background = set()
    if conversations_path is None:
        conversations_path = os.environ.get("OUTLOUD_CONVERSATIONS_DB")
        if conversations_path is None and production:
            conversations_path = Path("recordings/conversations.sqlite3")

    def broadcast(event):
        for connection in list(clients.values()):
            public_event = event
            if event["type"] == "state.updated":
                public_event = {**event, "state": {
                    **event["state"], "ui_connected": bool(clients),
                    "client_connected": connection.alive(),
                    "capture_owned": app.state.runtime.owns_capture(connection.session_id),
                }}
            connection.deliver(public_event)

    def conversation_changed(conversation_id):
        broadcast({"type": "conversation.updated", "conversation_id": conversation_id})

    def persist_transcript(event):
        store = app.state.conversations
        allowed, applied = store.apply_transcript(event["recording_id"], event["conversation_id"], event["text"])
        if not allowed:
            app.state.runtime.transcripts.delete_conversation(event["conversation_id"])
            return False, applied
        return True, applied

    async def complete_write(operation):
        # An accepted mutation includes its cleanup and metadata notification.
        # Request/socket cancellation must not strand a committed database write.
        task = asyncio.create_task(operation)
        background.add(task)
        task.add_done_callback(background.discard)
        return await drain(task)

    async def prepare_transcript(event):
        async def commit():
            allowed, applied = await asyncio.to_thread(persist_transcript, event)
            if applied:
                conversation_changed(event["conversation_id"])
            return allowed
        return await complete_write(commit())

    async def complete_transcript(event):
        try:
            if await prepare_transcript(event):
                broadcast(event)
            conversation_changed(event["conversation_id"])
        except sqlite3.Error:
            # The inbox retains the original text. Reconnect/restart replay will
            # retry the transaction before exposing the result to a browser.
            logger.exception("Could not append transcript to saved draft")
            broadcast({"type": "transcription.error", "message": "Transcript is saved but the draft could not be updated. Reconnect to retry."})

    def publish(event):
        def deliver():
            if event["type"] == "transcription.completed":
                task = asyncio.create_task(complete_transcript(event))
                background.add(task)
                task.add_done_callback(background.discard)
            else:
                broadcast(event)
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(deliver)

    @asynccontextmanager
    async def lifespan(app):
        nonlocal loop
        # Validate generation configuration before opening stores or workers.
        chat = Chat(ollama_client_factory, max_concurrent=int(os.environ.get("OUTLOUD_MAX_CHAT_GENERATIONS", "2")))
        loop = asyncio.get_running_loop()
        runtime = runtime_factory(publish)
        app.state.runtime = runtime
        app.state.conversations = await asyncio.to_thread(ConversationStore, conversations_path)
        app.state.study = StudyStore(app.state.conversations)
        app.state.study_extractor = UploadExtractor(chat.client_factory, chat.reserve_model)
        chat.study = app.state.study
        chat.store = app.state.conversations
        chat.on_change = conversation_changed
        app.state.chat = chat
        # Recover inbox results even when no browser is connected after restart.
        def recover_drafts():
            for event in runtime.transcripts.replay():
                persist_transcript(event)
        await asyncio.to_thread(recover_drafts)
        runtime.start()
        try:
            yield
        finally:
            await app.state.chat.close()
            await asyncio.to_thread(runtime.stop, close_transcripts=False)
            if background:
                await drain(asyncio.gather(*list(background), return_exceptions=True))
            await asyncio.to_thread(runtime.transcripts.close)
            await asyncio.to_thread(app.state.conversations.close)
            loop = None

    app = FastAPI(title="OutLoud", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(allowed_origins),
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Session-ID"],
    )

    @app.middleware("http")
    async def validate_origin(request, call_next):
        origin = request.headers.get("origin")
        if request.url.path in ("/desktop/status", "/desktop/shutdown"):
            if desktop_token is None or request_shutdown is None:
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            if origin is not None:
                return JSONResponse({"detail": "Desktop control does not allow Origin"}, status_code=403)
        if origin is not None and origin not in allowed_origins:
            return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(DraftConflict)
    async def draft_conflict(request, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.exception_handler(sqlite3.OperationalError)
    async def database_error(request, error):
        # Never expose paths or raw database diagnostics to the browser.
        return JSONResponse({"detail": "Local conversation storage is busy or unavailable. Try again."}, status_code=503, headers={"Retry-After": "1"})

    def revoke(connection):
        connection.active = False
        if clients.get(connection.session_id) is connection:
            del clients[connection.session_id]
            app.state.runtime.release_owner(connection.session_id)
            app.state.chat.cancel(connection.session_id)

    def acknowledge_delivery(recording_id):
        # A result is acknowledged globally. Release every client's credit so a
        # second subscriber cannot exhaust its window on already-acknowledged IDs.
        for connection in clients.values():
            connection.release_delivery(recording_id)

    def require_live_client(session_id):
        connection = clients.get(session_id)
        if connection is not None and not connection.alive():
            revoke(connection)
            connection = None
        if connection is None:
            raise HTTPException(status_code=403, detail="An active client session is required")
        return connection

    async def require_client(request: Request):
        return require_live_client(request.headers.get("x-session-id", "")).session_id

    @app.get("/conversations")
    async def list_conversations():
        return await asyncio.to_thread(app.state.conversations.list)

    @app.post("/conversations", status_code=201)
    async def create_conversation(body: ConversationCreate):
        async def commit():
            try:
                await asyncio.to_thread(app.state.study.validate_workspace, body.subject_id, body.topic_ids, body.focus_topic_id)
            except LookupError as error:
                raise HTTPException(status_code=404, detail="Subject not found") from error
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            conversation = await asyncio.to_thread(app.state.conversations.create, body.title, body.subject_id, body.mode, body.topic_ids, body.focus_topic_id)
            conversation_changed(conversation["id"])
            return conversation
        return await complete_write(commit())

    @app.get("/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str):
        conversation = await asyncio.to_thread(app.state.conversations.get, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return conversation

    @app.patch("/conversations/{conversation_id}")
    async def update_conversation(conversation_id: str, body: ConversationUpdate):
        async def commit():
            before = await asyncio.to_thread(app.state.conversations.get, conversation_id)
            if before is None:
                raise HTTPException(status_code=404, detail="Conversation not found")
            subject_id = body.subject_id if "subject_id" in body.model_fields_set else before["subject_id"]
            subject_changed = "subject_id" in body.model_fields_set and body.subject_id != before["subject_id"]
            topic_ids = body.topic_ids if body.topic_ids is not None else ([] if subject_changed else before["topic_ids"])
            focus_topic_id = body.focus_topic_id if "focus_topic_id" in body.model_fields_set else (None if subject_changed else before["focus_topic_id"])
            focus_changed = focus_topic_id != before["focus_topic_id"]
            if any(key in body.model_fields_set for key in ("subject_id", "topic_ids", "focus_topic_id")):
                try:
                    await asyncio.to_thread(app.state.study.validate_workspace, subject_id, topic_ids, focus_topic_id)
                except LookupError as error:
                    raise HTTPException(status_code=404, detail="Subject not found") from error
                except ValueError as error:
                    raise HTTPException(status_code=422, detail=str(error)) from error
            updates = {"title": body.title, "draft": body.draft, "draft_version": body.draft_version}
            if "subject_id" in body.model_fields_set:
                updates["subject_id"] = body.subject_id
                if subject_changed and body.topic_ids is None:
                    updates["topic_ids"] = []
                    updates["focus_topic_id"] = None
            if "mode" in body.model_fields_set:
                updates["mode"] = body.mode
            if body.topic_ids is not None:
                updates["topic_ids"] = body.topic_ids
            if "focus_topic_id" in body.model_fields_set:
                updates["focus_topic_id"] = body.focus_topic_id
            conversation = await asyncio.to_thread(app.state.conversations.update, conversation_id, **updates)
            if conversation is None:
                raise HTTPException(status_code=404, detail="Conversation not found")
            if subject_changed:
                await asyncio.to_thread(app.state.study.reset_session_after_move, conversation_id, conversation['subject_id'], conversation['mode'], conversation['focus_topic_id'])
            elif focus_changed and conversation['mode'] == 'study' and conversation['subject_id'] is not None and conversation['focus_topic_id'] is not None:
                await asyncio.to_thread(app.state.study.ensure_session, conversation_id, conversation['subject_id'], conversation['focus_topic_id'])
            elif focus_changed and conversation['mode'] == 'study' and conversation['subject_id'] is not None:
                await asyncio.to_thread(app.state.study.clear_session, conversation_id)
            conversation_changed(conversation_id)
            return conversation
        return await complete_write(commit())

    @app.delete("/conversations/{conversation_id}", status_code=204)
    async def delete_conversation(conversation_id: str):
        async def commit():
            if not await asyncio.to_thread(app.state.conversations.delete, conversation_id):
                raise HTTPException(status_code=404, detail="Conversation not found")
            app.state.chat.cancel_conversation(conversation_id)
            await asyncio.to_thread(app.state.runtime.transcripts.delete_conversation, conversation_id)
            conversation_changed(conversation_id)
        await complete_write(commit())

    app.include_router(study_router(app, complete_write, require_client))

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    def state_snapshot(session_id=None):
        connection = clients.get(session_id)
        return {
            **app.state.runtime.snapshot(), "ui_connected": bool(clients),
            "client_connected": connection is not None and connection.alive(),
            "capture_owned": app.state.runtime.owns_capture(session_id),
        }

    def submit(action, session_id, conversation_id=None):
        try:
            app.state.runtime.command(action, session_id, conversation_id)
        except RecordingBusy as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except CapacityUnavailable as error:
            raise HTTPException(status_code=429, detail=str(error)) from error
        except RuntimeUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.get("/ready")
    async def ready():
        readiness = app.state.runtime.readiness()
        return JSONResponse(readiness, status_code=200 if readiness["ready"] else 503)

    def require_desktop_owner(request: Request):
        token = request.headers.get("x-outloud-desktop-token")
        if token is None or not secrets.compare_digest(token.encode("utf-8"), desktop_token.encode("utf-8")):
            raise HTTPException(status_code=403, detail="Desktop owner token required")

    @app.get("/desktop/status", dependencies=[Depends(require_desktop_owner)])
    async def desktop_status():
        runtime = getattr(app.state, "runtime", None)
        if runtime is None or not runtime.readiness()["ready"]:
            raise HTTPException(status_code=503, detail="Recording workers are unavailable")
        return {"status": "ready"}

    @app.post("/desktop/shutdown", status_code=202, dependencies=[Depends(require_desktop_owner)])
    async def desktop_shutdown():
        app.state.runtime.begin_shutdown()
        request_shutdown()
        return {"accepted": True}

    @app.get("/state")
    async def state(request: Request):
        return state_snapshot(request.headers.get("x-session-id"))

    @app.post("/chat")
    async def chat(body: ChatRequest, session_id=Depends(require_client)):
        connection = require_live_client(session_id)
        if connection.conversation_id is not None and connection.conversation_id != body.conversation_id:
            raise HTTPException(status_code=403, detail="Chat must use the client's conversation")
        conversation = await asyncio.to_thread(app.state.conversations.get, body.conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        mode = body.mode or conversation["mode"]
        topic_ids = body.topic_ids if body.topic_ids is not None else conversation["topic_ids"]
        focus_topic_id = body.focus_topic_id if "focus_topic_id" in body.model_fields_set else conversation["focus_topic_id"]
        try:
            await asyncio.to_thread(app.state.study.validate_workspace, conversation["subject_id"], topic_ids, focus_topic_id)
        except (LookupError, ValueError) as error:
            raise HTTPException(422, detail=str(error)) from error
        body = body.model_copy(update={"mode": mode, "topic_ids": topic_ids, "focus_topic_id": focus_topic_id})
        if mode == "study" and conversation["subject_id"] is not None and focus_topic_id is not None:
            await asyncio.to_thread(app.state.study.ensure_session, body.conversation_id, conversation["subject_id"], focus_topic_id)
        study_session = await asyncio.to_thread(app.state.study.session, body.conversation_id)
        if study_session is not None and len(body.messages[-1].content) > 3000:
            raise HTTPException(422, 'Study answers must be 3,000 characters or fewer to preserve reference context.')
        # The database read yields; expiry/disconnect during it must not start a
        # model task under a token already revoked by another coroutine.
        require_live_client(session_id)
        try:
            generation = app.state.chat.start(session_id, body)
        except ChatBusy as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ChatCapacityBusy as error:
            raise HTTPException(status_code=429, detail=str(error)) from error
        return StreamingResponse(
            app.state.chat.stream(generation), media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.post("/chat/cancel", status_code=202)
    async def cancel_chat(body: ChatCancelRequest, session_id=Depends(require_client)):
        return {"accepted": True, "active": app.state.chat.cancel(session_id, body.request_id)}

    @app.post("/recording/start", status_code=202)
    async def start_recording(body: PressRequest, session_id=Depends(require_client)):
        if await asyncio.to_thread(app.state.conversations.get, body.conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        require_live_client(session_id)
        submit("start", session_id, body.conversation_id)
        return {"accepted": True}

    @app.post("/recording/press", status_code=202)
    async def press(body: PressRequest, session_id=Depends(require_client)):
        submit("press", session_id, body.conversation_id)
        return {"accepted": True}

    @app.post("/recording/hands-free", status_code=202)
    async def hands_free(body: PressRequest, session_id=Depends(require_client)):
        submit("hands-free", session_id, body.conversation_id)
        return {"accepted": True}

    @app.post("/recording/release", status_code=202)
    async def release(session_id=Depends(require_client)):
        submit("release", session_id)
        return {"accepted": True}

    @app.post("/recording/stop", status_code=202)
    async def stop(session_id=Depends(require_client)):
        submit("stop", session_id)
        return {"accepted": True}

    @app.post("/shortcuts/fn", status_code=202)
    async def configure_fn(body: FnRequest, session_id=Depends(require_client)):
        try:
            app.state.runtime.configure_fn(session_id, body.enabled, body.conversation_id)
        except RecordingBusy as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {"accepted": True}

    @app.websocket("/events")
    async def events(websocket: WebSocket):
        if websocket.headers.get("origin") not in allowed_origins:
            await websocket.close(code=1008)
            return
        conversation_id = websocket.query_params.get("conversation_id")
        if conversation_id is not None and not 1 <= len(conversation_id) <= 128:
            await websocket.close(code=1003, reason="Invalid conversation ID")
            return
        await websocket.accept()
        connection = ClientConnection(
            secrets.token_urlsafe(32), websocket, app.state.runtime.transcripts, revoke, acknowledge_delivery, prepare_transcript,
            conversation_id=conversation_id, lease_seconds=owner_lease_seconds, clock=clock,
        )
        clients[connection.session_id] = connection
        tasks = []
        try:
            # Receive disconnects and watch liveness even if the initial ready
            # write stalls. The sender keeps ready ahead of all other messages.
            tasks = [
                asyncio.create_task(connection.send_events(state_snapshot)),
                asyncio.create_task(connection.send_controls()),
                asyncio.create_task(connection.send_levels()),
                asyncio.create_task(connection.send_transcripts()),
                asyncio.create_task(connection.receive_messages()),
                asyncio.create_task(connection.process_acknowledgements()),
                asyncio.create_task(connection.watch_lease()),
            ]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            # Finish client cleanup even if the ASGI server cancels this task.
            with anyio.CancelScope(shield=True):
                # Revoke only this client, never another tab or its recording.
                revoke(connection)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                with anyio.move_on_after(1):
                    try:
                        await websocket.close(code=1001)
                    except (RuntimeError, WebSocketDisconnect):
                        pass

    return app


app = create_app()


def main():
    desktop_token = os.environ.get("OUTLOUD_DESKTOP_TOKEN")
    if desktop_token is not None:
        def request_shutdown():
            runtime = getattr(desktop_app.state, "runtime", None)
            if runtime is not None:
                runtime.begin_shutdown()
            server.should_exit = True

        desktop_app = create_app(desktop_token=desktop_token, request_shutdown=request_shutdown)
        server = uvicorn.Server(uvicorn.Config(desktop_app, host="127.0.0.1", port=8765))
        if os.environ.get("OUTLOUD_DESKTOP_PARENT_STDIN") == "1":
            # EOF also handles an Electron crash: never leave capture orphaned.
            def watch_owner():
                for _ in sys.stdin:
                    pass
                request_shutdown()
            threading.Thread(target=watch_owner, name="desktop-owner", daemon=True).start()
        server.run()
        return
    uvicorn.run(app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
