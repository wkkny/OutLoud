# OutLoud

A local, voice-first chat app for macOS. Python records the microphone and
transcribes with Whisper; the backend saves the transcript to the conversation's
editable draft. Transcripts never auto-send. Review your text, then send it to local
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

Create a conversation with **New chat**, or select a saved one in the sidebar.
Click **Start recording** once to begin and **Stop recording** once to finish.
Recording stays bound to the conversation selected when it started, even if you
switch chats. Other tabs can connect and chat, but cannot take over the microphone.
Closing the initiating tab safely stops its recording.

Conversations, titles, messages, and drafts are stored locally in SQLite. Each tab
remembers its selection after reload. Rename or delete a chat using its controls.
Draft edits are saved automatically. If tabs make conflicting edits, the composer
keeps your unsaved text and asks you to review both drafts instead of overwriting
someone else's work.

Browser Fn/Globe capture, hold-to-record, and double-tap controls are removed.
Electron-owned shortcuts are a separate future integration; no Electron app is
included in this implementation.

## Connection recovery

Completed transcripts are appended to their originating saved draft before browser
delivery. A durable recording marker prevents duplicate appends during replay,
even if you edited or cleared the draft. Results remain available until acknowledged.
Initial connection failures and dropped sessions use bounded retry/backoff. After
retries are exhausted, the UI offers **Reconnect**. Your selection and unsaved
recovery text remain in this tab while the backend is unavailable.

The UI sends application heartbeats every 15 seconds and expects a matching reply
within 10 seconds. A missing reply closes the session and starts safe-stop checks.
The backend expires a client's lease after 90 seconds without a heartbeat and
queues a stop if that client owns capture, even if its WebSocket stays open. The longer
lease tolerates common background-tab timer throttling; a longer browser/OS
suspension can still require manual reconnect.

Delivery results and acknowledgement markers are stored in
`recordings/delivery.sqlite3`. Unacknowledged results survive backend restart and
replay in small batches. Conversations and drafts are stored separately in
`recordings/conversations.sqlite3`; set `OUTLOUD_CONVERSATIONS_DB` to override that
path. Saved drafts and chat history survive page reloads and backend restarts.

## Transcription capacity

OutLoud allows **3 outstanding transcriptions** by default, counting the active
job, queued jobs, and the current recording. A slot is reserved before microphone
startup. When capacity is full, new recordings are refused without closing the
client session; **Stop recording** still works. The UI reports when capacity is full. Slots reopen after transcription succeeds or fails, or after an
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
output tokens. Missing Ollama/model errors leave dictation available. One reply can
run per conversation, with two across the app by default. At capacity, Send reports
busy and keeps the draft; requests are not queued or retried automatically. Configure
`OUTLOUD_MAX_CHAT_GENERATIONS` before startup, for example
`OUTLOUD_MAX_CHAT_GENERATIONS=1 bun run dev` on a memory-constrained Mac.
See [chat setup, behavior, and measurements](CHAT.md).

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

CI uses the same `bun run check` command as local validation, filtered to the
workspace for each job. The backend matrix keeps running after a platform fails
so each platform reports its result. New commits cancel obsolete runs on the
same PR. Native Fn/Globe event-tap tests run only on macOS; shared shortcut
behavior is tested everywhere. Tests need neither physical microphone access
nor model downloads.

The aggregate **CI** check is the merge gate, so branch rules do not need to track
individual matrix job names. If removing or renaming it, update the required
status checks in GitHub's `Protect main` ruleset too.

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

Chat messages, drafts, and transcript deduplication markers are stored locally in
SQLite. Deleting a conversation removes its saved chat, draft, and pending delivery
text; saved audio files remain under `recordings/`. Transcription capacity is bounded,
and delivery uses bounded replay batches rather than an in-memory backlog. Disk usage is not capped or automatically pruned. Queued audio
jobs are not automatically resumed after backend restart, although their files
remain saved. Backend shutdown drains saved transcription jobs and can wait for
Whisper; it has no deadline. Do not expose the loopback backend to a network.

## More detail

- [Web UI controls and connection behavior](apps/web/README.md)
- [Backend API, ownership, readiness, and security](BACKEND.md)
- [Latency and memory measurements](METRICS.md)
