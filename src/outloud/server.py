import asyncio
import itertools
import os
from pathlib import Path
import secrets
import time
from typing import Literal
from contextlib import asynccontextmanager

import anyio
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .runtime import RecordingRuntime, RuntimeUnavailable
from .capacity import CapacityUnavailable

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


class Heartbeat(BaseModel):
    type: Literal["session.ping"]
    id: int = Field(strict=True, ge=0, le=9007199254740991)


class TranscriptAck(PressRequest):
    type: Literal["transcript.ack"]
    recording_id: str = Field(min_length=1, max_length=128)


client_message = TypeAdapter(Heartbeat | TranscriptAck)


class OwnerConnection:
    def __init__(self, session_id, websocket, inbox, revoke, *, conversation_id=None, lease_seconds=90, clock=time.monotonic):
        self.session_id = session_id
        self.websocket = websocket
        self.inbox = inbox
        self.revoke = revoke
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

    def alive(self):
        return self.active and self.clock() - self.last_heartbeat < self.lease_seconds

    def deliver(self, event):
        if not self.active:
            return
        if not self.alive():
            self.revoke(self)
            return
        completed = event["type"] == "transcription.completed"
        if completed:
            if self.conversation_id is not None and event["conversation_id"] != self.conversation_id:
                return
        elif event.get("session_id") not in (None, self.session_id):
            return
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

    async def send_events(self, state_snapshot):
        await self.send({
            "type": "session.ready", "session_id": self.session_id,
            "state": state_snapshot(),
        })
        self.ready_sent.set()
        # Stream replay directly: a backlog larger than the event queue must not
        # overflow it before the client can acknowledge anything.
        replay = self.inbox.replay(self.conversation_id)
        while self.active:
            batch = await asyncio.to_thread(lambda: list(itertools.islice(replay, 16)))
            if not batch:
                break
            for event in batch:
                if not self.active:
                    return
                await self.send(event)
        while True:
            event = await self.events.get()
            await self.send(event)
            if event["type"] == "connection.error":
                await self.websocket.close(code=1013)
                return

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
                self.release_delivery(parsed.recording_id)
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


def create_app(runtime_factory=None, *, owner_lease_seconds=90, clock=time.monotonic):
    runtime_factory = runtime_factory or production_runtime
    owner = None
    loop = None

    def publish(event):
        connection = owner
        if connection is None:
            return

        def deliver():
            if owner is connection:
                public_event = event
                if event["type"] == "state.updated":
                    public_event = {**event, "state": {**event["state"], "ui_connected": True}}
                connection.deliver(public_event)
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(deliver)

    @asynccontextmanager
    async def lifespan(app):
        nonlocal loop
        loop = asyncio.get_running_loop()
        runtime = runtime_factory(publish)
        app.state.runtime = runtime
        runtime.start()
        try:
            yield
        finally:
            await asyncio.to_thread(runtime.stop)
            loop = None

    app = FastAPI(title="OutLoud", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(ALLOWED_ORIGINS),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Session-ID"],
    )

    @app.middleware("http")
    async def validate_origin(request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
        return await call_next(request)

    def revoke(connection):
        nonlocal owner
        connection.active = False
        if owner is connection:
            app.state.runtime.release_owner(connection.session_id)
            owner = None

    def live_owner():
        if owner is not None and not owner.alive():
            revoke(owner)
        return owner

    async def require_owner(request: Request):
        connection = live_owner()
        session_id = request.headers.get("x-session-id", "")
        if connection is None or not secrets.compare_digest(session_id, connection.session_id):
            raise HTTPException(status_code=403, detail="An active owner session is required")
        return connection.session_id

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    def state_snapshot():
        return {**app.state.runtime.snapshot(), "ui_connected": owner is not None}

    def submit(action, session_id, conversation_id=None):
        try:
            app.state.runtime.command(action, session_id, conversation_id)
        except CapacityUnavailable as error:
            raise HTTPException(status_code=429, detail=str(error)) from error
        except RuntimeUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.get("/ready")
    async def ready():
        readiness = app.state.runtime.readiness()
        return JSONResponse(readiness, status_code=200 if readiness["ready"] else 503)

    @app.get("/state")
    async def state():
        return state_snapshot()

    @app.post("/recording/press", status_code=202)
    async def press(body: PressRequest, session_id=Depends(require_owner)):
        submit("press", session_id, body.conversation_id)
        return {"accepted": True}

    @app.post("/recording/hands-free", status_code=202)
    async def hands_free(body: PressRequest, session_id=Depends(require_owner)):
        submit("hands-free", session_id, body.conversation_id)
        return {"accepted": True}

    @app.post("/recording/release", status_code=202)
    async def release(session_id=Depends(require_owner)):
        submit("release", session_id)
        return {"accepted": True}

    @app.post("/recording/stop", status_code=202)
    async def stop(session_id=Depends(require_owner)):
        submit("stop", session_id)
        return {"accepted": True}

    @app.post("/shortcuts/fn", status_code=202)
    async def configure_fn(body: FnRequest, session_id=Depends(require_owner)):
        try:
            app.state.runtime.configure_fn(session_id, body.enabled, body.conversation_id)
        except RuntimeUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {"accepted": True}

    @app.websocket("/events")
    async def events(websocket: WebSocket):
        nonlocal owner
        if websocket.headers.get("origin") not in ALLOWED_ORIGINS:
            await websocket.close(code=1008)
            return
        conversation_id = websocket.query_params.get("conversation_id")
        if conversation_id is not None and not 1 <= len(conversation_id) <= 128:
            await websocket.close(code=1003, reason="Invalid conversation ID")
            return
        if live_owner() is not None:
            await websocket.close(code=1008, reason="Another tab owns the recording session")
            return
        await websocket.accept()
        # Accept may yield while another connection claims ownership. Recheck and
        # claim without an await; never hold a lock across a peer's blocked I/O.
        if live_owner() is not None:
            await websocket.close(code=1008, reason="Another tab owns the recording session")
            return
        connection = OwnerConnection(
            secrets.token_urlsafe(32), websocket, app.state.runtime.transcripts, revoke,
            conversation_id=conversation_id, lease_seconds=owner_lease_seconds, clock=clock,
        )
        owner = connection
        app.state.runtime.claim_owner(connection.session_id)
        tasks = []
        try:
            # Watch ownership and receive disconnects even if the initial ready
            # write stalls. The sender keeps ready ahead of all other messages.
            tasks = [
                asyncio.create_task(connection.send_events(state_snapshot)),
                asyncio.create_task(connection.send_controls()),
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
            # Finish releasing ownership even if the ASGI server cancels this task.
            with anyio.CancelScope(shield=True):
                # Old socket cleanup cannot revoke a replacement owner.
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
    uvicorn.run(app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
