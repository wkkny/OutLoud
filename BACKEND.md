# Local HTTP and WebSocket backend

To run the backend and web UI together, use `bun run dev` from the project root.
See [README.md](README.md) for setup and all repository checks.

To run only the backend, start from the project root:

```bash
uv run outloud
```

The server listens on **127.0.0.1:8765**. API documentation is at
`http://127.0.0.1:8765/docs`. There is one app entry point; the standalone Fn
recorder has been removed. `uv run python -m outloud` also starts this backend.

## Implementation

- `server.py`: FastAPI routes, origin/host checks, session ownership, and WebSockets.
- `runtime.py`: queues, worker supervision, readiness, and atomic state snapshots.
- `app.py`: shared recording worker and hold/double-tap controls, with independent
  Fn and on-screen hold sources.
- `fn_shortcut.py`: owner-scoped capture lifecycle and stale-callback rejection.
- `shortcuts.py`: gesture state machine and the native macOS Fn event tap.
- `transcription.py`: shared Whisper worker, transcript events, and latency metrics.

Recording and transcription run on separate threads. HTTP handlers enqueue commands
and return immediately; microphone access, model loading, and inference do not run
on the HTTP event loop. Worker events enter that loop through `call_soon_threadsafe`.

## State and readiness

`GET /state`, the WebSocket's `session.ready.state`, and `state.updated.state`
use the same snapshot shape:

- `revision`: increasing runtime-state revision; clients should ignore older revisions.
  Connection ownership (`ui_connected`) is added by the server, not tracked by this revision.
- `fn_shortcut`: `status` (`disabled`, `starting`, `enabled`, or `failed`) and a safe
  nullable `error`. Optional keyboard capture does not affect worker readiness.
- `pending_commands`: accepted controls not yet processed, including microphone startup
  in progress. A disconnected UI can confirm a stop only after this reaches zero.
- `recording`, `hands_free`, `mode`, `recording_id`, `conversation_id`: active recording.
  IDs and mode are null when idle.
- `transcription`: status (`idle`, `queued`, `processing`, or `unavailable`),
  `active_job`, and ordered `queued_jobs`. Jobs contain recording/conversation IDs only.
- `errors`: latest recording and transcription failures, retained until restart.
- `workers`: recording/transcription status (`starting`, `running`, `stopped`, or
  `failed`) and safe error summaries.
- `ready`, `shutting_down`, `ui_connected`: backend and connection availability.

Snapshots contain metadata, not audio, transcript text, filesystem paths, or session
credentials. They are consistent copies taken under a lock. Queue events are published
before enqueueing, so a fast transcription cannot start before being tracked as queued.
Completed/failed jobs leave the active slot; a fatal worker failure clears it too.

`GET /health` is liveness: the HTTP server responds. `GET /ready` returns 200 when
both workers are running and shutdown has not started, or 503 otherwise. It does
not load models or probe microphone permissions. A recoverable microphone or
transcription failure does not make the backend unready. Unexpected worker exits,
including a worker returning without an exception, do.

New presses and hands-free starts return 503 when required workers are unavailable. Release/stop remain
available if only transcription has failed, so the microphone can still be finalized.
Shutdown rejects new commands and marks intentional worker exits as stopped.
Workers are not automatically restarted. Readiness detects exited workers, not
hung inference calls; shutdown still has no deadline.

## Connect first

Open a WebSocket at `ws://127.0.0.1:8765/events` from the frontend. Allowed origins are
`http://localhost:5173`, `http://127.0.0.1:5173`, and the localhost/127.0.0.1 server
origins on port 8765. Other origins, including a missing WebSocket Origin, are rejected.

The first tab receives:

```json
{
  "type": "session.ready",
  "session_id": "<session-token>",
  "state": {
    "revision": 3,
    "pending_commands": 0,
    "fn_shortcut": {"status": "disabled", "error": null},
    "recording": false,
    "hands_free": false,
    "mode": null,
    "recording_id": null,
    "conversation_id": null,
    "transcription": {"status": "idle", "active_job": null, "queued_jobs": []},
    "errors": {"recording": null, "transcription": null},
    "workers": {
      "recording": {"status": "running", "error": null},
      "transcription": {"status": "running", "error": null}
    },
    "ready": true,
    "shutting_down": false,
    "ui_connected": true
  }
}
```

Keep the token in memory. Send it as `X-Session-ID` on recording requests. A second
tab is rejected while an owner is connected. Disconnecting invalidates the token
and queues a stop so captured audio is saved and transcribed. A new connection gets
a new token. Transcripts from the old session are not delivered to the new owner.

## HTTP routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | HTTP server liveness |
| GET | `/ready` | Worker readiness; 503 when unavailable |
| GET | `/state` | Recording, transcription, errors, workers, and connection snapshot |
| POST | `/recording/press` | Button down; body: `{"conversation_id":"chat-1"}` |
| POST | `/recording/hands-free` | Direct hands-free start; same body as press |
| POST | `/recording/release` | Button up |
| POST | `/recording/stop` | Explicit stop, including pointer cancellation |
| POST | `/shortcuts/fn` | Enable/disable owner-scoped Fn capture; body: `{"enabled":true,"conversation_id":"chat-1"}` |

Recording routes require the owner token and return **202 Accepted**, not a promise
that microphone startup succeeded. Observe WebSocket events for the actual result.
Missing/invalid tokens return 403; invalid request bodies return 422; unavailable
required workers or shutdown return 503.

Press/release gestures use the existing 300 ms double-tap window. Duplicate presses
are ignored. A double-tap continues one recording; a press during hands-free mode
stops it. The conversation is fixed at the start of each recording.

`/recording/hands-free` is independent of the double-tap window. Repeating it does
not create another stream. It can promote an existing hold to hands-free while
preserving the recording and its original conversation. Release is then ignored;
use stop or a new press to finish.

Send requests in order. If a pointer is canceled or the page loses the ability to
receive its release event, send `/recording/stop` rather than leaving a hold active.

If a command fails with an uncertain outcome, close the owner WebSocket. Its token
is invalidated and a final stop is enqueued after all already accepted commands.
Poll uncached `/state` to confirm `ui_connected` is false, `recording` is false,
`pending_commands` is zero, and the recording worker has not failed. This also covers
a press still inside microphone startup when the connection closes. If the backend
cannot confirm these conditions, report the stop as unconfirmed; do not silently
start another session.

## Fn capture

`POST /shortcuts/fn` requires the same owner token and returns 202. Native tap
installation runs on a separate thread; observe `fn_shortcut` in state snapshots
for actual success or a permission failure. The conversation ID is required for
both enabling and disabling. Fn is disabled for every new owner session.

Only Fn key modifier events are suppressed, and only while capture is enabled
for the current owner and required workers are available. Other modifier/key
events pass through. Enabling while Fn is held requires releasing it and making
a fresh press. macOS keyboard preferences are never changed.

Fn commands carry their event timestamp and enter the same recording queue as
HTTP controls. Overlapping Fn and on-screen holds do not restart the microphone
or release each other. A fresh press from either source stops hands-free even
while the other source's second tap is still held. Duplicate stop presses and
late releases do not restart audio. A recording keeps its original conversation
even if another control supplies a different ID.

Disable, owner disconnect, shutdown, worker failure, and event-tap loss invalidate
capture before any later callback can enqueue a command. Disabling an active or
starting shortcut queues a stop after earlier accepted commands. Native capture
loss also stops recording; a startup permission failure leaves existing on-screen
recording alone. Capture-thread exits (including `SystemExit`) are supervised.
A finished or stopped native run loop exits capture rather than spinning without
a keyboard source. Capture is not automatically retried. See the
[root README](README.md#fnglobe-shortcut) for permissions.

## WebSocket events

- `state.updated`: full snapshot under `state`.
- `worker.state`: `worker`, `status`, safe `error` summary.
- `recording.state`: `recording`, `hands_free`, `recording_id`, `conversation_id`.
- `recording.saved`: `recording_id`, `conversation_id`.
- `recording.error`: `message`, `recording_id`, `conversation_id`.
- `transcription.queued`: `recording_id`, `conversation_id`.
- `transcription.started`: `recording_id`, `conversation_id`.
- `transcription.completed`: `recording_id`, `conversation_id`, `text`.
- `transcription.error`: `recording_id`, `conversation_id`, `message`.
- `connection.error`: client fell behind; the socket closes with code 1013.

Sending the text `ping` produces `{"type":"pong"}`. The server also uses Uvicorn's
WebSocket connection handling. Disconnected sessions cannot issue new commands.

Each connection has a bounded event buffer so a slow browser cannot block audio
workers. Session tokens are excluded from worker events. Snapshot errors use safe
summaries; diagnostic error-event messages can contain paths from exceptions.

## Security and current limits

The standard command binds only to loopback. Host validation rejects unrelated hosts,
and origin checks reject unrelated browser origins for HTTP and WebSockets. CORS
allows only the listed local frontend origins. Non-browser HTTP clients may omit
Origin, but recording still requires the active session token.

This is protection against unrelated websites, not authentication against other
programs or users on the same machine. Do not expose the server to a network.

Not implemented in this step:

- Ollama chat and conversation persistence.
- Transcript replay/deduplication after reconnect. Files remain saved on disk.
- A bounded transcription queue or chunked long-recording transcription.

The backend's shutdown drains saved transcription jobs, so exiting can wait for
Whisper to finish. Run only one backend process; multiple processes would each own
independent microphone state.

## Verification

```bash
uv run python -m unittest discover -s tests -v
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/ready
curl http://127.0.0.1:8765/state
```

Tests exercise HTTP and WebSocket behavior using simulated recording, models,
and keyboard capture. Native event-tap calls are mocked; tests do not request
microphone or keyboard permissions or download Whisper models. Physical Fn/Globe
behavior and suppression of the macOS default action need a manual check on a Mac.
