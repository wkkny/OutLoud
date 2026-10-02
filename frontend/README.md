# Voice dump UI

A minimal voice-first interface built with React, TypeScript, Vite, Tailwind, and
shadcn/ui. Geist is bundled locally; no external font request is required.

## Run

Start the backend from the repository root:

```bash
uv run voice-dump-server
```

In a second terminal:

```bash
cd frontend
bun install
bun dev
```

Open **http://127.0.0.1:5173**. Keep the dev server on port 5173; the backend allows
that origin. Do not run the separate `uv run voice-dump` CLI alongside it.

## Use

- Hold the main button to record; release to stop.
- Double-tap for hands-free recording, then tap to stop.
- **Record hands-free** uses a direct backend command, independent of tap timing.
- When the main button is focused, Space/Enter work as hold-to-record keys.
- **Stop** also ends recording. Pointer cancellation or focus loss during a hold
  requests a stop.
- Transcripts append to the editable composer without replacing typed text.
- Only one tab owns the recording session. Close it before reconnecting another.
- If the backend disconnects, the composer remains usable. Use **Reconnect** after
  starting the backend again.

Recording uses the microphone on the Mac running Python, not the browser's microphone.
Grant the terminal microphone permission if macOS requests it.

The UI shows recording/transcription status, queue count, connection status, pending
controls, and errors. Commands are sent in order and state revisions prevent older
snapshots from replacing newer ones. Duplicate transcript IDs are ignored within
this page session.

Connecting has a five-second deadline, including waiting for a valid `session.ready`
message after the socket opens. On timeout or handshake failure, the socket closes
and **Reconnect** becomes available. Late events from expired attempts are ignored.
Retry is manual, and typed text is preserved.

Existing recording/transcription errors from the initial snapshot appear as
**Previous … error**, with a timestamp and recording ID when available. These are
historical failures, not a declaration that the backend is currently unavailable.
Dismissal lasts for this page session, including reconnects. New live errors still
appear separately, even if an older error was dismissed.

If a command fails or the connected socket disconnects, queued controls are canceled
and the owner session is closed. The backend invalidates its token and queues a stop.
The UI polls uncached state to confirm the session is gone, recording is idle, and
all control commands have finished. It does not mistake an idle snapshot during
microphone startup for a completed stop. Retry is blocked during these checks.

If confirmation fails, the UI says the stop is unconfirmed rather than claiming
success. Check or restart the backend; **Reconnect** checks safety again before
opening a new session. Recordings/transcripts are still saved, but transcripts
completed during this safety disconnect are not replayed into the composer yet.

## Current limits

Send is disabled until Ollama chat is added. Fn is not connected to the browser UI.
Drafts are kept only in memory and disappear on reload. Manual reconnect does not
replay transcripts completed while disconnected; saved recordings remain on disk.

Physical double-taps still use the backend's 300 ms window; the dedicated hands-free
action does not. Pointer capture plus window listeners handle outside releases.
Cancellation, capture loss, focus loss, and a hidden page stop a held recording.
Hands-free recording continues across focus changes until explicitly stopped.
Multiple pointers cannot release each other's holds.

## Verify

```bash
bun run test
bun run build
bun run lint
```
