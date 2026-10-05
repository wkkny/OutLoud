# Throwaway packaged-backend feasibility spike

This is a disposable packaging experiment against `a43edd2cefc170a6eb178b1f693e7d0b6dae2b35`
on `prototype/study-release`, run on macOS arm64 on 2026-10-04. It does not implement
the release, modify production entrypoints, or produce a distributable installer.
The experiment asks whether the actual backend and native dependencies can run
from a relocated artifact without a source checkout as their working directory or
a developer PATH. The 15-minute budget includes inspecting dependencies, building,
and probing; retained outputs are ignored.

## Reproduce

Build prerequisites: macOS arm64, uv, Python 3.11 available through uv, Apple
Command Line Tools already installed, internet access for ordinary packages and
the FFmpeg source archive. The script does not install Command Line Tools or
modify system Python. Run from the checkout root:

```sh
uv run --no-project --python 3.11 python apps/desktop/prototype-packaging/build.py
```

Probe the built artifact:

```sh
uv run --no-project --python 3.11 python apps/desktop/prototype-packaging/probe.py
```

All environment/build/artifact/log outputs live under
`apps/desktop/prototype-packaging/.output/`, ignored by the local `.gitignore`.
The build exports existing `uv.lock` with `--frozen`, installs dependencies into
its own venv, installs the actual backend as a noneditable wheel, and uses
PyInstaller 6.22.3 with hooks-contrib 2026.8. It never changes the project lockfile
or dependency manifest. See `installed-versions.log` for the complete environment.
The artifact is `.output/dist/outloud-backend-spike/`; transfer the whole directory,
including `_internal`, rather than just its executable. uv/Python are build/probe
harness prerequisites, not artifact runtime prerequisites.

## What the launcher changes

The production `outloud.server.main()` hard-codes port 8765. The throwaway launcher
calls the existing `create_app()` and `uvicorn.Server` directly to select an unused
loopback port. It supplies the existing authenticated desktop shutdown callback.
It supplies **no** alternate runtime, recorder, transcription worker, model, or
Ollama client. Existing production SQLite paths remain relative to the scratch
per-user working directory, as in the desktop launch design. It does not reproduce
Electron's parent-stdin lifecycle watcher; the probe owns and cleans up its child.

The probe copies the artifact to a temporary directory outside the repository,
uses another temporary directory as cwd, and supplies only scratch HOME/TMPDIR/
XDG_CACHE_HOME, a fresh secret owner token, and `/usr/bin:/bin:/usr/sbin:/sbin` PATH.
No inherited PYTHONPATH, DYLD overrides, model cache, database override, proxies,
or developer environment is forwarded. The launcher adds its own bundled FFmpeg
directory to PATH. The repository and developer tools still exist on the host;
this is relocation/environment isolation, not proof from a clean machine.

The probe selects an unused loopback port with a temporary socket reservation,
then checks authenticated `/desktop/status` to guard against a bind race. It
checks `/health` and `/ready`, creates a conversation, saves its draft through the
actual API, requests owner-only graceful shutdown, restarts against the same
scratch data, and verifies the title/draft/library through the API. It never
requests recording, shortcuts, chat generation, or image OCR. Only its own child
can be terminated on failure; existing servers, Ollama, ports, and user data are
untouched. Scratch data and the relocated artifact are removed afterward. Logs
are bounded and owner tokens are redacted.

## Native dependencies and FFmpeg provenance

The freeze uses the actual Whisper, torch, NumPy, sounddevice, PortAudio, PDFium,
Pillow, Quartz/CoreFoundation, and backend packages. PyInstaller's contributed
sounddevice hook copies the wheel's `_sounddevice_data/portaudio-binaries/libportaudio.dylib`.
The PDFium hook collects `pypdfium2_raw`'s native library and version data. Whisper
assets, distribution metadata, and tiktoken extension modules are collected
explicitly. The native probe imports these packages, exercises a CPU torch tensor
operation and NumPy dot product, queries PortAudio's library version without
opening a stream, decodes a generated silent WAV through Whisper's actual
`load_audio()`/FFmpeg path, computes mel features, and round-trips its tokenizer.
It also uses production `study_uploads.prepare()` for PNG preparation and PDF
text extraction and exercises PDFium rendering. These checks are not inference.

FFmpeg is built from the [official FFmpeg 8.0 source archive](https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz),
with SHA256 `b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e`.
The digest pins bytes retrieved over HTTPS; a release-signature verification was
not performed. Third-party autodetection, networking, GPL, nonfree, and version-3
components are disabled. Only the WAV/PCM functionality needed by this backend's
16-kHz mono recording path is enabled. General MP3/video decoding is outside this
experiment. The exact configure arguments are in `build.py` and the artifact's
`THIRD-PARTY-FFMPEG/BUILD.json`.

The FFmpeg CLI's internal libraries are statically linked; no third-party external
libraries are enabled. `otool -L` reports only libSystem and Apple CoreFoundation,
CoreVideo, and CoreMedia. No Homebrew FFmpeg binary is copied. The artifact carries
the exact unmodified source tarball, LGPL v2.1 license, checksum, build command, and
notice alongside the replaceable standalone executable. This provides a traceable
source/binary experiment following the [FFmpeg project's licensing guidance](https://ffmpeg.org/legal.html).
Full product notices and redistribution compliance review for FFmpeg and all other
native dependencies remain release work.

`probe.py` audits every bundled Mach-O file for an arm64 slice and rejects
absolute dependencies outside Apple system libraries/frameworks and symlinks
escaping the artifact. It records complete results in `native-linkage.json`.
This static audit does not prove all possible delayed loads or model execution
paths; the runtime checks cover only the paths described above. PyInstaller's
[hook documentation](https://pyinstaller.org/en/latest/hooks.html) describes how
native libraries/data are collected; passing a freeze alone is insufficient.

## Observations and experiment history

The checkout's initial development venv lacked PDFium and Pillow; the isolated
environment installed the declared dependencies successfully. Initial package
versions included Python 3.11.16, torch 2.14.1, NumPy 2.4.6, openai-whisper 20250625,
sounddevice 0.5.6, pypdfium2 5.13.0, and Pillow 12.3.0.

The first onedir freeze succeeded at approximately 734 MiB. Its relocated native
probe failed at the real `whisper.load_audio()` call: FFmpeg reported
`Requested output format 's16le' is not known`. The configure option had used
`--enable-muxer=s16le,f32le`; FFmpeg's internal component names are
`pcm_s16le,pcm_f32le`. The correction is retained in the build script. The failed
probe is preserved in `.output/attempt-1-native-probe.log`; it was not replaced
by an alternate decoder or mocked inference. All 191 initial bundled Mach-O files
passed the architecture/absolute-linkage audit.

Final corrected-build/probe result: **PASS**, completed within approximately ten
minutes including the failed experiment and correction. The unpacked artifact is
**769,639,062 bytes (734.0 MiB)** including the matching FFmpeg source archive;
this counts ordinary files once and excludes symlink duplication. Both the
backend launcher and FFmpeg are Mach-O arm64 executables. All **191** bundled
Mach-O files have an arm64 slice; the audit found no non-system absolute load
paths or escaping symlinks.

The successful relocated probe used unused loopback port **60805**. Its fresh
owner credential authenticated `/desktop/status`; `/health` returned `ok` and
`/ready` reported both real recording and transcription workers running. API
conversation creation/draft save survived graceful shutdown and restart.
`recordings/conversations.sqlite3` and `recordings/delivery.sqlite3` were created
only in the temporary user-data directory, subsequently removed. The native
probe confirmed the loaded PortAudio path was inside the relocated `_internal`
directory, PortAudio V19.7.0-devel, PDFium 153.0.7999.0, an 80×100 Whisper mel
feature array, tokenizer round-trip, real FFmpeg WAV decode, PDF text extraction
and rendering, and image preparation. No model weights were involved.

Machine-readable evidence: `.output/build-result.json`, `.output/probe-result.json`,
and `.output/native-linkage.json`. Bounded startup/shutdown/API logs are in
`.output/backend-probe.log`; native details are in `.output/native-probe.log`.
Successful dependency/export/FFmpeg/PyInstaller build logs are also retained.
The probe exited successfully after both owned backend processes exited with
status zero. No production files, dependency manifests, or lockfiles were
changed by this spike; no commits, pushes, or issues were created.

## Explicitly unvalidated

- **UNVALIDATED:** microphone permission attribution, consent/denial recovery,
  native recording, and Fn/Globe permissions. No streams or prompts were opened.
- **UNVALIDATED:** real Whisper inference, Ollama/Gemma inference, image OCR,
  model installation, download progress, and model readiness. No models were
  downloaded, loaded, or faked. Worker readiness only means workers are alive.
- **UNVALIDATED:** clean-machine isolation, minimum macOS version, Intel,
  Windows/Linux, and packaged Electron integration.
- **UNVALIDATED:** Developer ID signing, hardened runtime, notarization,
  Gatekeeper, installer behavior, and tester distribution. PyInstaller's local
  ad-hoc signing is not validation of trusted release signing.
- **UNVALIDATED:** existing desktop-data migration/upgrade/retention. Scratch
  conversation persistence across restart does not exercise an upgrade.

Next experiment: embed the corrected backend directory in the actual Electron
app bundle and validate it on a clean Apple Silicon machine without uv, Python,
Homebrew, repository files, or cached models; then perform separately consented
native microphone/real-inference checks and signing/notarization validation.
The approximately 734-MiB unpacked baseline warrants a later size audit before
committing to the installer/download design.
