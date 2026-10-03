# Spec #3 smoke tests

Tested on 2026-10-03 after pulling `origin/main` to `b8490aa`, with the spec #3
working-tree backend. Hardware was a 16 GB Apple Silicon Mac running macOS 27.0.1.
Ollama already served `gemma3:4b` on `127.0.0.1:11434`.

## Method

Started an isolated loopback backend with a temporary conversation database and
injected idle recording/transcription targets. Two WebSocket clients received
independent session tokens, each selected a separate conversation, and submitted
the same synthetic prompt at once through the real HTTP `/chat` interface:

> Write three short sentences explaining why local-first chat is useful. Plain text only.

Both NDJSON streams were consumed to completion. Read-back verified each conversation
contained a saved complete user/assistant pair. Backend active generations were
sampled every 10 ms. System memory/swap and
`sysctl kern.memorystatus_vm_pressure_level` were sampled every 500 ms.

The normal model configuration was used: 4,096 context tokens, 1,024 maximum output
tokens, two concurrent backend generations, and Ollama's existing runtime settings.
The test did not alter or restart the user's Ollama instance.

## Results

| Measurement | Request A | Request B |
| --- | --- | --- |
| Wall time | 4.918 s | 6.138 s |
| First delta | 3.556 s | 5.029 s |
| Output tokens | 47 | 39 |
| Reply length | 265 characters | 234 characters |
| Terminal event | `chat.done` | `chat.done` |

Peak backend active generations was **2**. There were 13 memory samples:

- Minimum available memory: 1.924 GiB.
- Maximum observed swap usage: 3.831 GiB. Existing swap was not reset, so this is
  total system usage rather than swap attributable to this test.
- Pressure levels: 1 (normal) and 2 (warning).

## What this establishes

The backend accepted and completed two independent concurrent requests, streamed
both replies, and persisted isolated histories. The second request's first delta
arrived after the first stream finished, so Ollama appeared to serialize token
output. The application concurrency cap does not configure Ollama's scheduler.

Memory pressure reached warning level on this already-running Mac. The default
cap of two is a product setting, not a promise of resource headroom. Set
`OUTLOUD_MAX_CHAT_GENERATIONS=1` if pressure is sustained, and repeat the test on
the intended machine/workload before increasing the limit.

No physical microphone or Whisper inference ran in this test. Concurrent live
recording/transcription plus chat still needs a manual hardware check. Deterministic
HTTP/WebSocket and browser tests cover the control and persistence behavior without
requiring microphone access or model downloads.

## Two-tab browser check

The browser check used a separate backend on port 8876 with temporary SQLite stores,
a simulated recorder, and a fixed Whisper result (`Browser smoke dictation`). Vite
ran on port 5174 with `VITE_BACKEND_URL=http://127.0.0.1:8876`; the preview server
allowed that origin for this check only. The usual dev servers were left untouched.
Chat still used the real local Ollama instance.

Checked with two browser tabs:

- Created and renamed conversations A and B. Both tabs saw the same library, while
  each retained its own selected conversation and draft across reload.
- Started capture in A. B stayed connected and showed the microphone-occupied state.
- Switched A's selection to B while recording, then stopped. Dictation was saved to
  A's original draft, while B's independent draft stayed unchanged.
- Sent a short message in A. Gemma replied `Hello there!`; the accepted draft cleared,
  and the saved user/assistant messages and metrics returned after reload. B still
  showed its own draft, without A's reply.
- Created and deleted a third disposable conversation. Its removal appeared in both
  libraries without deleting A or B or changing B's selection.

This checks the actual browser/backend wiring. Bounded reconnect exhaustion, CAS
conflicts, storage failures, partial replies, and cancellation races are covered by
fixture tests, not a physical network or microphone failure in this browser check.

## Hardware microphone attempt

On 2026-10-03, the MacBook Air input stream opened under the backend launched by the
dev runner, but the saved WAVs contained only zero-valued PCM. Whisper returned empty
transcripts or the silence hallucination `you`.

Follow-up on 2026-10-04: launching the backend from cmux, which has macOS microphone
access enabled, resolved the silent input. A macOS speech sample played through the
MacBook Air speakers was captured by the built-in microphone (38.36 seconds, peak
sample 9,325, RMS 965.7); Whisper transcribed the sample into the composer draft.
The backend returned to idle after stopping capture. This verifies the physical
input and Whisper path when the backend runs under a mic-authorized launcher.

A final manual check with a person speaking while Gemma is generating, then stopping
recording and generation independently, remains to be done. Keep the backend running
from a launcher with microphone permission, such as cmux, for that check.
