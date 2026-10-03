# OutLoud UI

A minimal voice-first interface built with React, TypeScript, Vite, Tailwind, and
shadcn/ui. Geist is bundled locally; no external font request is required.

## Run

From the repository root, install dependencies and start both servers:

```bash
bun run setup
bun run dev
```

To run only this frontend, use `bun run dev:web` from the root. Start the backend
separately with `bun run dev:backend` or `uv run outloud`. See the
[root README](../../README.md) for prerequisites and workspace commands.

Open **http://127.0.0.1:5173**. Keep the dev server on port 5173; the backend allows
that origin. Run only one backend instance.

## Use

- Hold the main button to record; release to stop.
- Double-tap for hands-free recording, then tap to stop.
- **Record hands-free** uses a direct backend command, independent of tap timing.
- When the main button is focused, Space/Enter work as hold-to-record keys.
- **Stop** also ends recording. Pointer cancellation or focus loss during an on-screen hold
  requests a stop.
- **Enable Fn shortcut** opts this owner session into macOS Fn/Globe capture. Hold
  to record, double-tap for hands-free, and tap to stop. The same controls show its state.
- Fn capture works across apps while this tab is connected, not just while it has
  focus. Turning it off stops recording and restores the default Fn action.
- Keyboard permission failures appear next to the toggle and do not disable the
  on-screen controls. See the [root README](../../README.md#fnglobe-shortcut) for permissions.
- Transcripts append to the editable composer without replacing typed text.
- Only one tab owns the recording session. Close it before reconnecting another.
- If the backend disconnects, the composer remains usable. Use **Reconnect** after
  starting the backend again.

Recording uses the microphone on the Mac running Python, not the browser's microphone.
Grant the terminal microphone permission if macOS requests it.

The UI shows recording/transcription status, queue count, transcription slot usage,
connection status, pending
controls, and errors. Commands are sent in order and state revisions prevent older
snapshots from replacing newer ones. Duplicate transcript IDs are ignored within
this page session.

Connecting has a five-second deadline, including waiting for a valid `session.ready`
message after the socket opens. On timeout or handshake failure, the socket closes
and **Reconnect** becomes available. Late events from expired attempts are ignored.
Retry is manual, and typed text is preserved.

Established sessions send an application heartbeat every 15 seconds. A matching
reply must arrive within 10 seconds, otherwise the UI closes the owner socket and
runs the same safe-stop checks as a disconnect. Visibility/page-resume events
request an immediate probe. The backend's 90-second lease tolerates common
background timer throttling, but expires a suspended or unresponsive owner and
releases Fn capture. Fn stays off after reconnect.

The socket subscribes to `local-draft`. Completed transcripts are acknowledged
only after their text has committed to the composer, including empty results.
Missed results replay on reconnect; already-applied IDs are acknowledged again
without re-inserting text. Lost acknowledgement confirmations retry on the next
connection. Results for other conversations are neither inserted nor acknowledged.

Existing recording/transcription errors from the initial snapshot appear as
**Previous … error**, with a timestamp and recording ID when available. These are
historical failures, not a declaration that the backend is currently unavailable.
Dismissal lasts for this page session, including reconnects. New live errors still
appear separately, even if an older error was dismissed.

If a command fails, the connected socket disconnects, or a fatal `connection.error`
event arrives, queued controls are canceled
and the owner session is closed. The backend invalidates its token and queues a stop.
The UI polls uncached state to confirm the session is gone, recording is idle, and
all control commands have finished. It does not mistake an idle snapshot during
microphone startup for a completed stop. Retry is blocked during these checks.

If confirmation fails, the UI says the stop is unconfirmed rather than claiming
success. Check or restart the backend; **Reconnect** checks safety again before
opening a new session. Recordings/transcripts are still saved. Results completed
during this safety disconnect replay after reconnect, including after a backend
restart.

## Current limits

Chat uses Ollama Gemma `gemma3:4b`; setup is documented in [CHAT.md](../../CHAT.md).
Press Send explicitly after reviewing text. Responses stream as plain text; Stop
generation keeps partial text without stopping recording. Failed/stopped turns
are excluded from later context and can be copied back into the composer.
Conversations and reply metrics disappear on reload. Ollama failures leave the
recording session connected, and edits made while the model loads are preserved.
Fn capture is off by default and
resets on disconnect, reload, or backend restart. Drafts are kept only in memory
and disappear on reload. The backend's delivery index is stored in SQLite and
survives backend restart; replay reads small batches rather than holding the
backlog in memory. The backend sends at most 16 unacknowledged results at once,
and the browser keeps at most 16 acknowledgement requests in flight, including
reconnect retries. Confirmations advance both windows; slow storage does not
block heartbeat processing. Acknowledgement is not durable draft persistence;
already-acknowledged text is not restored to a reloaded page. Saved recordings
remain on disk. Neither recording files nor delivery markers are automatically
pruned.

## Full transcription capacity

The default 3 slots include the active job, queued audio, and the current
recording. The UI blocks new starts when full but retains Stop/release, including
a held pointer while its pending start reserves the last slot. HTTP 429 and
`recording.rejected` show a capacity message without disconnecting or discarding
the draft. Fn interception remains enabled; a fresh press can stop hands-free at
capacity. Capacity reopens after a job finishes or fails. Backend configuration
uses `OUTLOUD_MAX_TRANSCRIPTIONS`, a positive integer.

Physical double-taps still use the backend's 300 ms window; the dedicated hands-free
action does not. Pointer capture plus window listeners handle outside releases.
Cancellation, capture loss, focus loss, and a hidden page stop a held recording.
Hands-free recording continues across focus changes until explicitly stopped.
Multiple pointers cannot release each other's holds.

## Verify

Run all repository checks from the root with `bun run check`. For web-only checks:

```bash
cd apps/web
bun run test
bun run build
bun run lint
```

Use Vitest through `bun run test`, not Bun's native `bun test`. Dependencies are
managed by the root `bun.lock`; this workspace has no separate lockfile.
