# OutLoud desktop (development)

Electron reuses the React chat UI and manages one local Python backend. This is a
development app, not a self-contained installer. Targets are macOS, Windows, and
Linux; actual Electron smoke validation currently covers macOS, not real
Windows/Linux audio.

## Launch

From the repository root:

```bash
bun run setup
bun run dev:desktop
```

Use the existing pinned Python/Bun versions and Node.js prerequisites. Install
FFmpeg on PATH and, on Linux, PortAudio (for example `libportaudio2` on Debian/
Ubuntu). Install/start Ollama and pull `gemma3:4b` for chat. Ollama remains an
independently managed service; missing models do not prevent recording.

The command builds Electron, starts a dedicated Vite server at
`http://127.0.0.1:5174`, then opens OutLoud. Electron starts the repository's
`.venv/bin/python` (`.venv/Scripts/python.exe` on Windows) directly, without a
shell. The backend remains at `127.0.0.1:8765`. Stop another backend before
launching: OutLoud never attaches to or kills an existing process. Port 5174 must
also be free. `bun run dev` still launches the original browser app on port 5173.

On first Electron launch its npm package downloads the platform binary if
necessary. Python dependencies must already be installed with `bun run setup`.
This app does not install or bundle Python, FFmpeg, Whisper models, or Ollama.

Recording happens in Python on this computer, not in Chromium. Grant microphone
access to the launching application if the OS asks. Real microphone permission,
capture, Whisper transcription, and Ollama chat still need manual validation on
each target OS. No Accessibility permission is needed for this milestone;
Fn/Globe and other global recording shortcuts are not implemented.

## Data and lifecycle

Desktop data is separate from the repository's browser data:

- macOS: `~/Library/Application Support/OutLoud/recordings/`
- Windows: `%APPDATA%/OutLoud/recordings/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/OutLoud/recordings/`

Conversations and delivery state use SQLite; each recording also retains its audio,
transcript, and metrics. The desktop launcher ignores `OUTLOUD_CONVERSATIONS_DB`
so a browser override cannot silently redirect desktop data. No migration or disk
retention policy is included. Clients connected to this same managed backend see
its shared conversation library.

Unsaved desktop draft edits are also cached in the per-user Electron profile,
including edits made just before closing or while Python is unavailable. Reopening
recovers them and uses the existing draft merge/conflict checks before saving them
to SQLite. Browser draft recovery remains scoped to its tab.

Closing the window stops recording and shows **Finishing transcription…** while
Python finishes accepted jobs. There is **no automatic shutdown timeout**.
**Force quit…** opens a warning, defaults to **Keep waiting**, and terminates only
the owned process tree after explicit confirmation. Unfinished jobs are not
automatically resumed. Saved data/audio remains, but an active audio file may not
have been finalized if graceful stop itself is stuck.

There is no tray/background mode. On macOS, the Dock app may remain after the
window and backend close; reopening its window starts a fresh backend against the
same data directory. On Windows/Linux, closing the window exits the app.
Ctrl+C requests the same graceful quit and waits, rather than silently killing
Python. An Electron crash closes an owner pipe, which asks Python to stop capture
and drain work too.

## Security and limitations

The renderer has no Node integration, runs sandboxed with context isolation, and
never receives the backend owner credential. Popup windows are denied. A narrow
local control page handles shutdown progress; its force-quit IPC rejects chat
pages and subframes. Owner-only HTTP controls reject every Origin header and are
disabled in the ordinary browser backend. The managed backend additionally
allows only the exact desktop UI origin `http://127.0.0.1:5174`.

This is loopback browser-origin protection, not isolation from hostile local
programs. Do not expose the backend to the network. The Vite development server is
not a packaged production renderer. React changes hot-reload; restart
`bun run dev:desktop` after changing Electron or Python code.

## Validation

```bash
bun run --cwd apps/desktop test
bun run --cwd apps/desktop build
bun run --cwd apps/desktop smoke
```

Portable tests exercise process/lifecycle behavior using an HTTP subprocess
fixture. The optional Playwright Electron smoke requires a graphical desktop,
free ports 5174/8765, and the installed Python environment. It uses a temporary
data directory, checks the real window, renderer isolation, conversation/draft
persistence, shutdown, and macOS reopen. On macOS it also pauses only its own
Python process to simulate a stuck shutdown and checks the native Force quit
warning, Keep waiting, and confirmed termination (dialog answers are simulated).
It does not record audio or download models. CI runs desktop tests/build/lint on all three OSes, not the GUI smoke.
