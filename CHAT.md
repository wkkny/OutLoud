# Local Gemma chat

OutLoud sends reviewed text to **Ollama on `127.0.0.1:11434`**, using
**`gemma3:4b`**. Dictation never auto-sends. The Python backend handles generation;
the browser receives a streamed reply and can stop it without stopping recording.

## Setup on macOS

Install Ollama using its macOS app, or Homebrew:

```bash
brew install ollama
```

If the Ollama app is not already serving, start it in a separate terminal:

```bash
ollama serve
```

Download the model (several GB; requires an internet connection for this step):

```bash
ollama pull gemma3:4b
ollama list
```

From the OutLoud repository root:

```bash
bun run setup
bun run dev
```

Open `http://127.0.0.1:5173`. Type or dictate, review the composer, then press
**Send**. **Stop generation** preserves any partial reply. Ollama errors do not
close the recording session or disable Fn. A failed/stopped turn offers **Use
this text again**; this puts it back into the composer without sending it.

## Context and resource choices

- Model: `gemma3:4b`.
- Ollama `num_ctx`: **4,096 tokens**.
- Ollama `num_predict`: at most **1,024 output tokens**.
- Keep the model loaded for **2 minutes** after use, rather than indefinitely.
- One active generation across the backend, owned by the connected browser tab.
- Connection timeout: 3 seconds; upstream inactivity timeout: 60 seconds;
  generation deadline: 180 seconds.
- The frontend sends up to 32 completed turn pairs plus the current user turn.
  Failed/stopped pairs are displayed but excluded from subsequent model context.
- The backend keeps recent whole pairs within a **12,000-character input budget**,
  retaining the newest user turn. This is a payload/history bound, not an exact
  Gemma token count. Ollama's 4,096-token window is the actual token limit.
- A user message longer than 12,000 characters is rejected, not shortened.
- Upstream chunks are buffered in a bounded 16-event queue; reply text is capped
  at 65,536 characters as an additional safety limit.

Chat is optional. `/ready` describes recording/transcription workers, not Ollama.
A missing model or stopped Ollama daemon leaves dictation available. Owner
expiry/disconnect cancels generation; chat requests do not renew the owner lease.
Closing/aborting the HTTP stream also cancels upstream work.

## Draft and conversation behavior

The composer clears only after Ollama produces non-whitespace reply text.
Empty header chunks do not accept the draft; empty/whitespace-only replies report
an error and leave the draft intact. Leading whitespace is preserved once real
content arrives. If its text changed
while the model was loading, those edits/new transcripts are preserved instead.
New dictation can continue while Gemma is generating and remains in the composer
for the next explicit Send.

Messages and generation metrics are **page-memory only**. Reload loses the chat
history. Nothing is written to a conversation database yet. Saved dictation audio,
transcripts, and delivery acknowledgements retain their existing behavior.

Only plain text is rendered. Markdown, attachments, tools, model switching,
automatic retries, and regeneration are not implemented.

## Measurements on the 16 GB Mac

Completed replies show elapsed time and output-token count. The stream also
returns first-token latency and Ollama's input/output token counts and
load/generation/total durations when available. These metrics describe this
request, not full-system memory usage.

For a first real-model check:

1. Generate a short reply after starting Ollama; note cold-load and elapsed time.
2. Generate another reply while the model is warm.
3. Record and transcribe a short clip while a reply is generating; verify Stop
   generation and recording Stop still work independently.
4. Inspect `ollama ps` and macOS Activity Monitor's memory pressure/swap. Monitor
   both Ollama and the Python backend; Python's resource sampler does not include
   the independent Ollama process.
5. Repeat after the two-minute idle interval to observe model unloading/reloading.

The implementation has fixture-based tests and a real HTTP transport smoke test.
**Actual Gemma performance and combined Whisper/Gemma memory use still require
this local-model check.**

## HTTP streaming contract

`POST /chat` requires the owner `X-Session-ID`, the usual origin checks, and JSON:

```json
{
  "request_id": "unique-request-id",
  "conversation_id": "local-draft",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

Messages must alternate user/assistant roles, begin/end with user, and contain
non-whitespace text. A scoped owner must use its subscribed conversation.

The response is newline-delimited JSON (`application/x-ndjson`, no-store):

- `chat.started`: `request_id`, model, context limit; acceptance before deltas.
- `chat.delta`: `request_id`, `text`.
- `chat.done`: `request_id`, numeric `metrics`.
- `chat.error`: `request_id`, safe `message`.
- `chat.cancelled`: `request_id`.

`done`, `error`, and `cancelled` are terminal. An error before `started` leaves
the draft intact. HTTP 403 means missing/expired/wrong-conversation ownership;
409 means another generation is active; 422 means invalid input. Once streaming
has begun, generation errors are terminal JSON events rather than HTTP errors.

`POST /chat/cancel` with `{"request_id":"unique-request-id"}` requires the same
owner and returns 202. A stale ID cannot cancel a newer generation. Cancellation
is idempotent. Stop, HTTP abort, owner revocation, and shutdown share a cancellation
guard so repeated requests cannot interrupt asynchronous upstream cleanup.
Browser cancellation also aborts its fetch as a fallback.

The Ollama destination/model are fixed; proxy environment variables are ignored.
No prompt or response text is included in recording metadata snapshots. The
backend does not log normal prompts/replies. Other local programs remain outside
OutLoud's authentication threat model; do not expose either server to a network.
