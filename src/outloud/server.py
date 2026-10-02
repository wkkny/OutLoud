import asyncio
import secrets
from contextlib import asynccontextmanager

import anyio
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .runtime import RecordingRuntime, RuntimeUnavailable

ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
}


class PressRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128)


class OwnerConnection:
    def __init__(self, session_id, websocket):
        self.session_id = session_id
        self.websocket = websocket
        self.events = asyncio.Queue(maxsize=128)
        self.overflowed = False

    def deliver(self, event):
        if self.overflowed or event.get("session_id") not in (None, self.session_id):
            return
        public_event = {key: value for key, value in event.items() if key != "session_id"}
        try:
            self.events.put_nowait(public_event)
        except asyncio.QueueFull:
            self.overflowed = True
            # A slow client must not block the recording or transcription threads.
            while not self.events.empty():
                self.events.get_nowait()
            self.events.put_nowait({
                "type": "connection.error",
                "message": "Client could not keep up with events; reconnect.",
            })

    async def send_events(self):
        while True:
            event = await self.events.get()
            await self.websocket.send_json(event)
            if event["type"] == "connection.error":
                await self.websocket.close(code=1013)
                return

    async def receive_messages(self):
        while True:
            message = await self.websocket.receive_text()
            if message == "ping":
                self.deliver({"type": "pong"})


def create_app(runtime_factory=RecordingRuntime):
    owner = None
    loop = None
    owner_lock = asyncio.Lock()

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

    async def require_owner(request: Request):
        session_id = request.headers.get("x-session-id", "")
        if owner is None or not secrets.compare_digest(session_id, owner.session_id):
            raise HTTPException(status_code=403, detail="An active owner session is required")
        return owner.session_id

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    def state_snapshot():
        return {**app.state.runtime.snapshot(), "ui_connected": owner is not None}

    def submit(action, session_id, conversation_id=None):
        try:
            app.state.runtime.command(action, session_id, conversation_id)
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

    @app.websocket("/events")
    async def events(websocket: WebSocket):
        nonlocal owner
        if websocket.headers.get("origin") not in ALLOWED_ORIGINS:
            await websocket.close(code=1008)
            return
        async with owner_lock:
            if owner is not None:
                await websocket.close(code=1008, reason="Another tab owns the recording session")
                return
            await websocket.accept()
            connection = OwnerConnection(secrets.token_urlsafe(32), websocket)
            owner = connection
        tasks = []
        try:
            await websocket.send_json({
                "type": "session.ready",
                "session_id": connection.session_id,
                "state": state_snapshot(),
            })
            tasks = [
                asyncio.create_task(connection.send_events()),
                asyncio.create_task(connection.receive_messages()),
            ]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            # Finish releasing ownership even if the ASGI server cancels this task.
            with anyio.CancelScope(shield=True):
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                async with owner_lock:
                    if owner is connection:
                        # Enqueued before a new owner can issue commands.
                        app.state.runtime.stop_recording(connection.session_id)
                        owner = None

    return app


app = create_app()


def main():
    uvicorn.run(app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
