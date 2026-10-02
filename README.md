# OutLoud

A local, voice-first chat app for macOS. Python records the microphone and
transcribes with Whisper; a React interface appends the transcript to an editable
composer. Transcripts never auto-send. Ollama chat is planned, but not connected yet.

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

Send is disabled until chat is connected. Drafts and transcript deduplication
are held in page memory, and transcripts completed
while disconnected are not replayed after reconnect. The transcription queue is
not bounded yet. Backend shutdown drains saved transcription jobs and can wait
for Whisper; it has no deadline. Do not expose the loopback backend to a network.

## More detail

- [Web UI controls and connection behavior](apps/web/README.md)
- [Backend API, ownership, readiness, and security](BACKEND.md)
- [Latency and memory measurements](METRICS.md)
