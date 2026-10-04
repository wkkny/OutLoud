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

Recording happens in Python on this computer, not in Chromium. No Accessibility
permission is needed for this milestone; Fn/Globe and other global recording
shortcuts are not implemented.

## Microphone permission

On macOS, the first click on **Start recording** checks native microphone access
and opens the system permission prompt if consent has not been decided. Recording
waits for approval. Already-granted access needs no prompt; denied access blocks
recording and offers **Open microphone settings**. Enable access in **System
Settings > Privacy & Security > Microphone**, then close and reopen OutLoud. macOS
does not show the prompt again after denial. Restricted access requires help from
your administrator. Stop recording never asks for permission.

The development executable is still `Electron.app`, so macOS may name it
**Electron**, not OutLoud, in permission dialogs and Settings. It already has a
generic `NSMicrophoneUsageDescription`. A packaged app needs its own bundle
identity and microphone purpose string.

Windows uses the system microphone-access status and opens microphone privacy
Settings after denial; Electron cannot show the macOS consent prompt there.
Linux leaves permission handling to native capture because these Electron APIs
are unsupported. Browser clients still use Python capture without requesting a
second microphone stream in Chromium.

Permission approval does not prove that the Python child can capture audio. Its
macOS permission attribution depends on the launch chain, which still needs a
real-device check. Capture errors retain their existing recovery messages. Real
OS prompts, denial recovery, audio capture, Whisper transcription, and Ollama chat
need manual validation on each target OS. See
[Electron's permission API](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos).

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
pages and subframes. Microphone permission and Settings IPC accept only the active
chat's main frame and expose no arbitrary shell command or URL. Chromium
permission requests remain denied; audio capture belongs to Python.
Owner-only HTTP controls reject every Origin header and are
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
fixture and native permission behavior using simulated OS APIs. The optional Playwright Electron smoke requires a graphical desktop,
free ports 5174/8765, and the installed Python environment. It uses a temporary
data directory, checks the real window, renderer isolation, conversation/draft
persistence, shutdown, and macOS reopen. It checks the denial/Settings flow and
rejects permission IPC from another window, with native permission and Settings
APIs simulated so the test cannot prompt or record. On macOS it also pauses only its own
Python process to simulate a stuck shutdown and checks the native Force quit
warning, Keep waiting, and confirmed termination (dialog answers are simulated).
It does not record audio or download models. CI runs desktop tests/build/lint on all three OSes, not the GUI smoke.
