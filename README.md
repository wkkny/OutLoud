# OutLoud

OutLoud is a local, voice-first chat and study app. It has a browser UI and an
Electron development app. A Python backend records audio from the computer's
microphone, transcribes it with Whisper, and saves the transcript into the
selected conversation's editable draft. **A transcript is never sent
automatically:** review it, then choose Send to get a streamed reply from the
local Gemma model through Ollama.

The app runs its servers on loopback (`127.0.0.1`). It is designed for one
computer, not as a hosted or network-accessible service. The browser and desktop
apps use separate local data stores.

## Quick start

### 1. Install prerequisites

- **Python 3.11**. The repository pins it in `.python-version` and `mise.toml`.
  If you use [mise](https://mise.jdx.dev/), run `mise install` from the repo.
- **uv** for Python environment and dependency management:
  [install uv](https://docs.astral.sh/uv/getting-started/installation/).
- **Bun 1.4.2** for JavaScript dependencies and workspace commands:
  [install Bun](https://bun.sh/docs/installation).
- **Node.js 22.12+ in the 22.x series, or Node.js 24** for frontend tooling.
- **FFmpeg** on `PATH` for audio processing. With Homebrew on macOS:
  `brew install ffmpeg`.
- **PortAudio** on Linux for microphone capture. On Debian or Ubuntu, install
  `libportaudio2` with your system package manager.

The Electron development app also needs a working graphical desktop. On
macOS, allow microphone access for the development app when prompted. On Linux,
confirm the selected audio input is available to PortAudio. Python, FFmpeg,
Whisper models, and Ollama are separate from Electron; this repo does not bundle
them into an installer.

### 2. Install project dependencies

Run from the repository root:

```bash
bun run setup
```

This installs JavaScript packages from `bun.lock` and Python packages from
`uv.lock`. It creates the local `.venv` used by the backend. Keep `bun.lock` and
`uv.lock` committed versions in place; setup uses frozen/locked installs.

### 3. Start the browser app

```bash
bun run dev
```

Open **http://127.0.0.1:5173**. The command starts both services:

- Web UI: `http://127.0.0.1:5173`
- Python backend: `http://127.0.0.1:8765`
- Interactive backend API docs: `http://127.0.0.1:8765/docs`

Press **Ctrl+C** in the terminal to stop both. The ports are fixed; stop any
existing process using 5173 or 8765 before starting. Vite reloads web changes.
Restart the command after changing Python code.

On the first recording, Whisper downloads its `base` model and caches it outside
the repository. You do not need to download a model manually. Recording uses the
microphone on the machine running Python, not the browser's microphone. On
macOS, grant microphone access to the terminal or app that launched the backend.

### 4. Enable chat (optional)

Recording and transcription work without Ollama. To get assistant replies, install
[Ollama](https://ollama.com/download), start its local service if the app has not
already started it, and download the model:

```bash
ollama serve
ollama pull gemma3:4b
```

Keep `ollama serve` running in a separate terminal when needed. Then review text
in the OutLoud composer and select **Send**. Missing Ollama or the model leaves
recording and dictation available. More about chat limits and behavior is in
[CHAT.md](CHAT.md).

## Use OutLoud

### Chat and voice dictation

1. Select **New chat** or choose a saved conversation in the sidebar.
2. Select **Start recording**, speak, then select **Stop recording**.
3. Review or edit the transcript in the draft. It is saved automatically.
4. Select **Send** (or press **Cmd/Ctrl+Enter**) to request a Gemma reply.

Plain Enter adds a new line. The reply streams into the conversation. **Stop
generation** keeps any partial reply and does not stop recording. New dictation
can continue while a reply is generating; it stays in the composer for a later
send.

Only one recording can run at a time across connected tabs. A recording stays
attached to the conversation selected when it began, even if you switch chats.
Other tabs can view and chat but cannot take over the microphone. Closing the
initiating tab safely stops its capture. When a connection drops, the app retries
and offers **Reconnect** if needed. Unsaved draft text is kept for recovery.

Conversations, messages, and drafts are stored on this computer. Tabs share the
backend's saved conversation library, while each browser tab remembers its own
selection and keeps its unsaved edits. Conflicting edits are surfaced for review
instead of silently replacing one another.

OutLoud suggests a title from the first sent message after the assistant replies.
If you rename a conversation yourself, OutLoud keeps your title.

### Study mode

Select **Study** to make a subject, add topics or import a syllabus, choose an
exam type, and study a topic. Explain your understanding in the composer, then
send it for feedback and a follow-up question. The study dashboard tracks
assessment evidence and revision priorities. Study mode uses the same local
Ollama model as chat.

You can add printed PDFs or clear PNG, JPEG, or WebP images as a syllabus or
reference. Check the extracted text and approve it before it can guide an
assessment. A file can be up to 8 MB; PDF imports use up to five selected pages.
Handwriting recognition is not supported. Study feedback can be provisional or
incorrect, so check it against your source material. See [Study mode details](docs/study-mode.md).

## Run the desktop development app

After `bun run setup`, run from the repository root:

```bash
bun run dev:desktop
```

Electron starts a dedicated UI on **http://127.0.0.1:5174** and manages its own
Python backend on port **8765**. Stop another backend first; the desktop app
never attaches to or kills a backend it did not start. Port 5174 must also be
free. To stop, close the window or press Ctrl+C in the launching terminal.

The desktop app uses its own per-user data directory, separate from browser data.
Closing the window stops recording and waits for accepted transcription work to
finish. There is no tray or background mode. Changes to React hot-reload; restart
`bun run dev:desktop` after editing Python or Electron code. See
[desktop launch, permissions, lifecycle, and data](apps/desktop/README.md).

## Run one service at a time

Run these commands from the repository root. For a working browser app, keep the
web and backend services running in separate terminals:

```bash
bun run dev:web       # Web UI only, at 127.0.0.1:5173
bun run dev:backend   # Python backend only, at 127.0.0.1:8765
```

Equivalent direct commands are:

```bash
cd apps/web && bun run dev
uv run outloud
# or: uv run python -m outloud
```

The backend permits the default web origin on port 5173. Changing the Vite port
requires changing the backend's allowed-origin configuration as well. Run only
one backend at a time.

## Commands

Run from the repository root unless noted:

| Command | Purpose |
| --- | --- |
| `bun run setup` | Install JavaScript and Python dependencies |
| `bun run dev` | Start the browser UI and backend together |
| `bun run dev:web` | Start only the browser UI |
| `bun run dev:backend` | Start only the backend |
| `bun run dev:desktop` | Build and launch the Electron development app |
| `bun run test` | Run Python unittest and frontend Vitest suites |
| `bun run build` | Type-check/build the web UI and Electron main/preload code |
| `bun run lint` | Run frontend lint |
| `bun run check` | Validate dependencies, tests, builds, and frontend lint |

Use `bun run test`, not Bun's native `bun test`; the frontend uses Vitest. Backend
tests simulate audio and model responses, so tests do not need a microphone,
Whisper model download, or running Ollama. Turborepo may reuse local successful
web task results from `.turbo/`. Force those tasks to run again with:

```bash
bun run check -- --force
```

Desktop-specific checks are documented in [apps/desktop/README.md](apps/desktop/README.md).

## Configuration

No `.env` file is required for local development. Optional environment variables
can be set on the command that starts the backend:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTLOUD_MAX_TRANSCRIPTIONS` | `3` | Maximum outstanding transcription jobs, including active and queued work |
| `OUTLOUD_MAX_CHAT_GENERATIONS` | `2` | Maximum simultaneous Ollama generations across the app |
| `OUTLOUD_CONVERSATIONS_DB` | `recordings/conversations.sqlite3` | Override the browser/development conversation database path |

The limits must be positive integers. For example, reduce concurrent chat
generation on a memory-limited computer:

```bash
OUTLOUD_MAX_CHAT_GENERATIONS=1 bun run dev
```

For the desktop development app, its launcher manages backend startup and its
own data location. Do not start a second backend alongside it.

## Data and privacy

In a repository-root development run, recordings are saved under `recordings/`:

```text
recordings/<timestamp>_<id>/
  audio.wav
  transcript.txt     # if transcription succeeds
  metrics.json
```

The browser/development backend stores conversation and study data in
`recordings/conversations.sqlite3` and pending transcript delivery in
`recordings/delivery.sqlite3`. `OUTLOUD_CONVERSATIONS_DB` changes the conversation
database path. Desktop data is instead kept in the operating system's per-user
application data directory; see the desktop README for exact paths.

Audio remains on disk if transcription fails. Deleting a conversation removes
its saved chat, draft, and pending transcript text, but does not delete recording
files. Disk usage is not automatically capped or pruned. Whisper's model cache is
outside the repository. The backend is loopback-only; do not expose it to a
network. See [backend behavior and security](BACKEND.md).

## Troubleshooting

- **The app says the backend is unavailable:** confirm both services started in
  `bun run dev`, then open `http://127.0.0.1:8765/ready`. Stop old processes on
  ports 5173 or 8765 and restart.
- **Recording cannot start:** check OS microphone permission, confirm an input
  device is connected, and make sure FFmpeg and (on Linux) PortAudio are
  installed. Microphone capture happens in Python on this computer.
- **Transcription fails on first use:** check internet access for the initial
  Whisper model download, available disk space, and that FFmpeg is on `PATH`.
  The saved audio file remains available under `recordings/`.
- **Chat cannot connect or find Gemma:** start Ollama, then run
  `ollama pull gemma3:4b`. Check `ollama list`. Chat is optional; dictation
  should still work without it.
- **The desktop app will not launch:** verify setup completed, ports 5174 and
  8765 are free, and a graphical session is available. Electron downloads its
  platform package during dependency installation if needed.
- **A draft or transcript looks missing after a connection loss:** use
  **Reconnect** and reopen the original conversation. Unacknowledged transcripts
  are durably queued and replayed; do not manually paste a transcript twice.

## Project layout

```text
apps/web/             React, TypeScript, and Vite browser UI
apps/desktop/         Electron shell and managed-backend lifecycle
src/outloud/          Python recording, transcription, chat, and API backend
tests/                Python backend tests
tooling/backend/      Bun workspace scripts that invoke uv from the repo root
package.json          Root commands and Bun workspaces
bun.lock              JavaScript dependency lockfile
pyproject.toml        Python package and dependencies
uv.lock               Python dependency lockfile
```

The desktop app reuses `apps/web/`; it does not have a separate frontend. Bun
manages JavaScript dependencies, and uv manages Python dependencies.

## Further reading

- [Web UI controls and behavior](apps/web/README.md)
- [Desktop setup and lifecycle](apps/desktop/README.md)
- [Local Gemma chat](CHAT.md)
- [Study mode](docs/study-mode.md)
- [Backend API and recovery](BACKEND.md)
- [Performance measurements](METRICS.md)
