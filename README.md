# OutLoud

A local, voice-first chat app for macOS. Python records the microphone and
transcribes with Whisper; a React interface appends the transcript to an editable
composer. Transcripts never auto-send. Review your text, then send it to local
Gemma `gemma3:4b` through Ollama for a streamed reply.

## Prerequisites

- macOS and Python 3.11 (pinned in `.python-version` and `mise.toml`).
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for Python dependencies.
- [Bun](https://bun.sh/docs/installation) 1.4.2 for JavaScript dependencies and scripts.
- Node.js 22.12+ in the 22.x series, or Node.js 24, for the frontend tooling.
- FFmpeg on your PATH: `brew install ffmpeg` if you use Homebrew.

If you use mise, run `mise install` to install the pinned Python version.

## Setup and development

From the repository root:

```bash
bun run setup
bun run dev
```

Setup installs both dependency sets from their lockfiles. Turborepo starts the
backend and Vite together, with both logs in the terminal:

- UI: **http://127.0.0.1:5173**
- Backend: **http://127.0.0.1:8765**
- API docs: **http://127.0.0.1:8765/docs**

Press **Ctrl+C** to stop both servers. A failed development task stops the other
server too. Ports are fixed; stop existing instances before starting development.
Vite reloads frontend changes. Restart `bun run dev` after changing Python code.

Recording uses the microphone on the Mac running Python, not the browser's
microphone. Allow microphone access for the terminal or application launching the
backend when macOS asks. Whisper downloads the `base` model on the first
transcription; later transcriptions use the cached local model.

Hold the recording button and release to stop, or choose **Record hands-free**
and then **Stop**. Transcripts append without replacing typed text. Only one
browser tab can own the recording session.

## Fn/Globe shortcut

In the UI, check **Enable Fn shortcut**. Capture is off by default and only works
while this tab owns a connected backend session:

- Hold Fn/Globe to record; release to stop.
- Double-tap for one uninterrupted hands-free recording; tap again to stop.
- The on-screen controls show the same recording state and can stop Fn recordings.

While enabled, capture works across apps, even with the browser in the background.
OutLoud suppresses the captured Fn key's default action without changing macOS
keyboard preferences. Turning the toggle off or disconnecting the owner tab stops
recording and releases capture. Reconnects require opting in again.

Keyboard capture needs macOS **Accessibility** permission for the terminal or app
launching the backend, and **Input Monitoring** if macOS requests it. Set these in
**System Settings → Privacy & Security**. Restart the backend (and quit/reopen the
terminal if macOS asks), reconnect, then enable the toggle again. Permission errors
appear next to the toggle; on-screen recording still works without keyboard access.
If macOS disables the event tap, OutLoud stops recording and asks you to re-enable
capture rather than silently resuming it.

## Connection recovery

Completed transcripts are retained until the composer acknowledges them. After
**Reconnect**, missed results replay into their original conversation. Repeated
results are acknowledged without inserting the text again, even if you edited it.
Fn remains off after reconnect; enable it again when ready.

The UI sends application heartbeats every 15 seconds and expects a matching reply
within 10 seconds. A missing reply closes the session and starts safe-stop checks.
The backend expires ownership after 90 seconds without a heartbeat, releasing Fn
capture and queuing a stop even if the browser's WebSocket stays open. The longer
lease tolerates common background-tab timer throttling; a longer browser/OS
suspension can still require manual reconnect.

Delivery results and acknowledgement markers are stored in
`recordings/delivery.sqlite3`. Unacknowledged results survive backend restart and
replay in small batches. This is not durable draft storage: reloading the page
clears the composer, and already-acknowledged text is not restored.

## Transcription capacity

OutLoud allows **3 outstanding transcriptions** by default, counting the active
job, queued jobs, and the current recording. A slot is reserved before microphone
startup. When capacity is full, new recordings are refused without closing the
owner session; Stop/release and stopping hands-free with Fn still work. The UI
shows slot usage. Slots reopen after transcription succeeds or fails, or after an
empty/failed recording releases its reservation.

Configure a positive limit when launching the backend or the combined dev task:

```bash
OUTLOUD_MAX_TRANSCRIPTIONS=5 bun run dev
# Or: OUTLOUD_MAX_TRANSCRIPTIONS=5 uv run outloud
```

Already-accepted commands are rechecked by the recording worker before microphone
startup; a rapid queued start may report a capacity rejection after HTTP 202.

## Local Gemma chat

Install/start Ollama and download the model:

```bash
brew install ollama
ollama serve                    # separate terminal, unless Ollama is already running
ollama pull gemma3:4b           # another terminal
```

Press **Send** after reviewing the composer. **Stop generation** preserves partial
text and does not stop recording. Chat uses a 4,096-token context and up to 1,024
output tokens. Missing Ollama/model errors leave dictation available. Conversations
are page-memory only. See [chat setup, behavior, and measurements](CHAT.md).

## Commands

Run these from the repository root:

| Command | What it does |
| --- | --- |
| `bun run setup` | Install Bun and uv dependencies using the committed lockfiles |
| `bun run dev` | Start the backend and web UI together |
| `bun run dev:web` | Start only the web UI |
| `bun run dev:backend` | Start only the backend |
| `bun run test` | Run Python unittest and frontend Vitest suites |
| `bun run build` | Type-check and build the web UI into `apps/web/dist/` |
| `bun run lint` | Run frontend lint |
| `bun run check` | Validate dependencies, then run tests, TypeScript/build, and frontend lint |

`check` first installs JavaScript dependencies with `--frozen-lockfile`, rejecting
out-of-date lockfiles. It then runs independent tasks in parallel and reports
failures with a nonzero exit code. Python dependency checks validate `uv.lock`
against `pyproject.toml` and check installed-package compatibility.

Turborepo caches successful web tests, lint, and build outputs locally in
`.turbo/`. Development tasks, backend tests, and dependency checks are never
cached. Remote caching is disabled. To rerun all checks without cache hits:

```bash
bun run check -- --force
```

Use `bun run test`, not Bun's native `bun test`; frontend tests use Vitest.
Automated backend tests use simulated audio and models, so they do not need
microphone access or a Whisper download.

The Python entry points still work independently:

```bash
uv run outloud
uv run python -m outloud
uv run python -m outloud.metrics
```

## Continuous integration

GitHub Actions runs [CI](.github/workflows/ci.yml) on every pull request targeting
`main`, including documentation-only changes. It does not run on branch pushes
or deploy the app.

- **Web (Linux):** Vitest tests, TypeScript checking and the Vite build, and oxlint.
- **Backend (Linux, Windows, macOS):** the Python unittest suite, lockfile validation,
  and installed-package compatibility checks. Python follows `.python-version`;
  Bun follows `package.json`'s `packageManager` field.
- **CI:** succeeds only when web validation and every backend matrix job pass.
  Failed, cancelled, or skipped validation jobs do not satisfy this check.

The backend matrix keeps running after a platform fails so each platform reports
its result. New commits cancel obsolete runs on the same PR. Dependency installs
use the committed lockfiles; Linux installs PortAudio for sounddevice. Native
Fn/Globe event-tap tests run only on macOS; shared shortcut behavior is tested on
every platform. Tests need neither physical microphone access nor model downloads.

Use the aggregate **CI** check as the required status check in the `Protect main`
GitHub ruleset after the first successful workflow run. Requiring it gates merges
on every platform without tying branch settings to individual matrix job names.
The other rules in that ruleset should remain unchanged.

## Repository layout

```text
apps/web/             React, TypeScript, Vite, shadcn/ui, and bundled Geist
src/outloud/          Python recording, transcription, HTTP/WebSocket backend
tests/               Python tests
tooling/backend/     Bun workspace scripts that invoke uv from the repo root
pyproject.toml       Python package and dependencies
uv.lock              Python dependency lockfile
package.json         Bun workspaces and root commands
bun.lock             One JavaScript lockfile for all workspaces
turbo.json           Task orchestration and cache configuration
```

Bun owns JavaScript dependencies; uv owns Python dependencies. The backend
workspace is just a command wrapper, not a second Python project. Its scripts
change to the repository root so recordings and the Python environment stay in
one place.

A desktop app can be added under `apps/desktop/`. When a second frontend needs
shared UI or protocol schemas, add `packages/*` to the root workspaces and
extract those modules then. There are no placeholder desktop or shared packages.

## Saved data and current limits

Recordings are stored under the repository root:

```text
recordings/<timestamp>_<id>/
  audio.wav
  transcript.txt     # when transcription succeeds
  metrics.json
```

Audio is retained when transcription fails. Recordings, dependencies, generated
web output, and Turbo caches are excluded from Git. Whisper's model cache lives
outside the repository.

Chat messages, drafts, and transcript deduplication are held in page memory. Transcription capacity is bounded; delivery results and
acknowledgement markers use disk storage with bounded replay batches, not an
in-memory backlog. Disk usage is not capped or automatically pruned. Queued audio
jobs are not automatically resumed after backend restart, although their files
remain saved. Backend shutdown drains saved transcription jobs and can wait for
Whisper; it has no deadline. Do not expose the loopback backend to a network.

## More detail

- [Web UI controls and connection behavior](apps/web/README.md)
- [Backend API, ownership, readiness, and security](BACKEND.md)
- [Latency and memory measurements](METRICS.md)
