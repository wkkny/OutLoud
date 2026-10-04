# Local HTTP and WebSocket backend

Run `bun run dev` for the UI and backend, or `uv run outloud` for the backend only.
The server listens on `127.0.0.1:8765`; API documentation is at `/docs`. See
[README.md](README.md) for setup and validation commands.

## Sessions and recording ownership

Each browser opens an independent WebSocket at `/events`. `session.ready` gives it
a fresh token, held in memory and sent as `X-Session-ID` on recording/chat requests.
The browser connection is not the owner of the whole backend. Only microphone
capture is exclusive.

An optional `conversation_id` query scopes transcript delivery and acknowledgements
for older clients. The browser uses an unscoped connection so switching conversations
does not close the socket or stop an active recording. A recording's conversation
is fixed when it starts.

Application heartbeats use `session.ping` and `session.pong`, carrying the same
integer `id`. The default lease is 90 seconds. Disconnect, lease expiry, invalid
messages, and a full event buffer revoke only that client's token. Revocation stops
its capture and cancels its generations, without interrupting another client.
A stalled socket cannot delay its lease watcher or another client's cleanup.

The recorder reserves ownership before microphone startup. A competing client
cannot start, release, or stop capture, including while a start is still pending.
Ownership remains reserved until queued controls finish and capture is idle.
Worker recovery clears failed holds; an idle handoff cannot inherit another
client's button state.

## Conversation library

The local SQLite store is `recordings/conversations.sqlite3`. Set
`OUTLOUD_CONVERSATIONS_DB` to override its path. Injected test runtimes use an
isolated in-memory store unless a path is supplied.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/conversations` | List the shared library, including titles and drafts |
| POST | `/conversations` | Create a chat; optional `title`, default `New chat` |
| GET | `/conversations/{id}` | Read saved messages and draft |
| PATCH | `/conversations/{id}` | Update `title` and/or `draft` |
| DELETE | `/conversations/{id}` | Delete draft/messages/pending transcript delivery; cancel its generation |

Conversation records contain `id`, `title`, `draft`, `draft_version`, `created_at`,
and `updated_at`. Detail records also contain `messages`, with role, text, status,
metrics, and creation time. Each accepted model turn persists a user/assistant pair.
Failed or cancelled partial replies remain readable but are excluded from context.
Unfinished pairs are marked failed after backend restart.

A draft update can supply its last known `draft_version`. SQLite compares it in the
same transaction as the write. A stale write returns 409 without changing saved
text; the browser must reload and review or merge its unsaved edits. Successful
draft changes increment the version. Title-only changes leave that version alone.
Missing conversations return 404. A deleted conversation is never recreated by a
late model reply or transcript.

All database work runs off the ASGI event loop. A busy/unavailable store returns
503 with a safe retry message, rather than delaying heartbeats or recording commands.
Conversation mutations publish `conversation.updated` with `conversation_id` to
all connected clients. The event contains metadata only; clients fetch current data.
Accepted writes drain through cleanup and notification even if their HTTP request
is cancelled. Shutdown waits for these writes before closing SQLite.

## Recording and transcript delivery

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/recording/start` | Start capture for an existing `conversation_id` |
| POST | `/recording/stop` | Stop the initiating client's capture |

The browser uses one click to start and another to stop. Starts return 202 after
queuing; observe state/events for the microphone's actual result. A repeated start
or competing capture returns 409. Invalid/expired tokens return 403, invalid bodies
422, unavailable workers 503, and full transcription capacity 429. Stops need no new
transcription slot.

Completed transcripts enter the durable inbox in `recordings/delivery.sqlite3`.
Before live delivery or replay, the backend atomically appends text to the original
conversation's draft and records its recording ID in the conversation database.
Replay cannot append twice, even across restart or after the draft is edited/cleared.
Startup recovers pending inbox results into drafts even without a connected browser.
A successful recovery append also notifies already-connected tabs. Duplicate replay
leaves the draft/version unchanged and does not emit another append notification.
The browser reloads the originating conversation and acknowledges the recording;
it must not append the event's text a second time.

Acknowledgement messages are `transcript.ack` with `recording_id` and
`conversation_id`; replies are `transcript.acknowledged`. Acknowledged inbox text is
removed, while the durable draft remains. Acknowledgements release delivery credits
for every subscriber, so multiple tabs do not exhaust their windows on the same
result. Unknown acknowledgements never tombstone a future completion.
Live delivery and replay use the same inbox sender, reading bounded batches of 16
with at most 16 unacknowledged results per client. Live completions wake the sender
instead of queueing duplicate payloads during replay. Repeated updates for the same
conversation are coalesced while queued. Heartbeat/control delivery is independent.

Deleting a conversation purges pending inbox text and retains an ID-only tombstone
so later transcription completion cannot restore deleted text. Saved audio files
are not deleted. Audio jobs themselves are not automatically resumed after restart.

Legacy `/recording/press`, `/recording/release`, `/recording/hands-free`, and
`/shortcuts/fn` endpoints remain for compatibility with existing runtime integrations.
The browser does not use them or configure/capture Fn. Building an Electron-owned
shortcut integration is outside this spec.

## State, readiness, and recovery

`GET /health` is HTTP liveness. `GET /ready` returns 200 only while both recording
and transcription workers are running, or 503 otherwise. It does not load Whisper,
probe microphone permissions, or require Ollama. Recoverable recording/transcription
failures leave the workers ready; unexpected worker exits do not.

`GET /state`, `session.ready.state`, and `state.updated.state` share the metadata
snapshot shape:

- `revision`, an increasing runtime revision; ignore older snapshots.
- `recording`, `recording_id`, `conversation_id`, and legacy `hands_free`/`mode`.
- `pending_commands`, including pending microphone startup.
- `capacity`, with transcription `limit`, `used`, and `available`.
- `transcription`, with status, `active_job`, and ordered `queued_jobs`.
- `workers`, `errors`, `ready`, and `shutting_down`.
- `ui_connected`, whether any browser client is connected.
- `client_connected`, whether the requesting client's lease is live.
- `capture_owned`, whether that client still owns the capture reservation.
- Legacy `fn_shortcut` metadata, ignored by the browser.

`GET /state` can receive the old `X-Session-ID` after a connection failure. A safe
stop is confirmed when that client's `client_connected` and `capture_owned` are
both false. Worker readiness separately controls whether capture can start again.
Another tab may still be
connected or recording; global `ui_connected=false` is no longer a recovery gate.
An unconfirmed stop is shown explicitly rather than allowing uncertain capture.

Recording/transcription use supervised threads. HTTP handlers enqueue microphone
controls; worker events cross into the event loop with `call_soon_threadsafe`.
Shutdown drains accepted recording/transcription work, then pending draft commits,
then closes the stores. It still has no deadline for Whisper inference.

## Chat and concurrency

`POST /chat` requires the client token and an existing conversation. The browser
sends only the reviewed user turn. SQLite supplies authoritative complete history;
client-supplied earlier turns are ignored. See [CHAT.md](CHAT.md) for NDJSON events,
Ollama setup, context limits, cancellation, and real-model measurements.

One generation runs per conversation. The app-wide cap defaults to two; set
`OUTLOUD_MAX_CHAT_GENERATIONS` to a positive integer to change it. Busy conversations
return 409; global capacity returns 429. Refused requests are not accepted, saved,
or queued. HTTP abort, explicit Stop, client revocation, and shutdown share guarded
cancellation. SQLite work must drain before releasing a generation's conversation
slot, including under repeated ASGI disconnect cancellation.

## Local security and tests

Trusted hosts are `localhost` and `127.0.0.1`. Allowed browser origins are the
localhost/127.0.0.1 UI on port 5173 and backend on port 8765. An Electron-managed
backend additionally allows the exact desktop origin `http://127.0.0.1:5174`. HTTP Origin, when
present, and WebSocket Origin are checked. CORS allows the conversation HTTP methods
and session/content headers. The backend is loopback-only, not a remote service.
Other local programs remain outside its authentication threat model.

Tests use temporary SQLite databases, HTTP/WebSocket clients, simulated recorders,
and fixture model streams. They cover restart recovery, shared drafts, transcript
routing/replay/deduplication, capture arbitration, generation limits, cancellation,
and blocked storage without microphone access or model downloads.
