# Electron development milestone

## Agreed scope

- Support a development Electron app targeting macOS, Windows, and Linux under `apps/desktop/`, reusing the existing React UI. Preserve the browser launch path.
- One root command launches Vite and Electron; Electron starts and owns Python. Python dependencies, FFmpeg, and Ollama are installed separately. Installers, global shortcuts, tray/background mode, and data migration are deferred.
- Recordings stay exclusive and bound to their originating conversation. Transcripts are saved to drafts, never auto-sent.
- Desktop data lives in a separate writable per-user OutLoud directory; browser data remains untouched. Ignore the browser conversation-path override for the managed desktop backend.
- Refuse an occupied backend port rather than attach to, control, or kill another process. Only the owning Electron process may request graceful shutdown; no renderer gets the owner credential.
- Closing the last window stops recording and shows “Finishing transcription…” while Python drains accepted work. No automatic shutdown deadline. Force quit requires a warning/confirmation that unfinished transcription can be lost. No hidden recording or backend after window close completes. macOS may retain the Dock app; reopening restarts Python.
- Surface startup failures and unexpected backend exits. Missing Ollama/model errors must leave recording available.

## Confirmed test surfaces

The user confirmed desktop lifecycle (startup, errors, port conflicts, close, drain, force quit), backend owner-only HTTP control (recording stops before drain), and shared UI behavior as the test seams. Use simulated subprocess/audio/model behavior for deterministic automated coverage, then smoke-test a real Electron window on macOS. Passing portable tests is not evidence of real Windows/Linux microphone support.

## Review baseline

Starting commit: `6b6a33997c5fc27eaaf7ec3704ae13cf19f9ad84`.
