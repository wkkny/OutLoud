# OutLoud UI

A local, voice-first chat interface built with React, TypeScript, Vite, Tailwind,
and shadcn/ui. The chat layout is adapted from
[shadcn-ui/chatbot-template](https://github.com/shadcn-ui/chatbot-template), with a
conversation sidebar and recording controls. Attribution is in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Geist is bundled locally.

## Run

From the repository root:

```bash
bun run setup
bun run dev
```

For just the frontend, use `bun run dev:web`. Start the backend separately with
`bun run dev:backend` or `uv run outloud`. Open **http://127.0.0.1:5173**; keep the
dev server on port 5173 because the backend allows that origin. Run only one
backend instance. See the [root README](../../README.md) for prerequisites.

## Use

- Create or select a saved conversation in the sidebar. It collapses on desktop
  with the header toggle or Cmd/Ctrl+B, and opens as a drawer on mobile. The
  desktop toggle stays in the top-left corner when the sidebar opens or closes.
- Rename or delete the selected conversation using the header dialogs. Deletion
  requires confirmation.
- Click the microphone in the composer to start recording, then click again to
  stop. Recording uses the microphone on the Mac running Python, not the browser.
- Transcripts append to the conversation that started recording. Switching
  conversations does not move the recording or its transcript.
- Review the editable draft, then click the send arrow or press **Cmd/Ctrl+Enter**.
  Plain Enter inserts a newline. Suggestions fill an empty draft; they never
  send automatically or replace existing words.
- Assistant replies stream with Markdown formatting. The stop-generation button
  cancels the displayed conversation's generation and retains its partial reply;
  it does not stop recording. Model HTML is not executed and images do not load
  automatically.

Conversations and saved drafts persist in the local backend and are shared across
browser tabs. Each tab remembers its selected conversation and retains unsaved
edits for recovery. Draft conflicts expose both versions for deliberate review.
Only one recording can run at a time; other tabs show microphone occupancy.

The app name appears only in the sidebar; the header shows the selected
conversation's title. Storage explanations and workspace/privacy footers stay
out of the interface. The composer keeps the send shortcut and shows draft
status only when changes are unsaved. Recording and recovery warnings remain.

Connection failures trigger bounded retries. **Reconnect** starts another attempt
and verifies that this tab has released any previous capture before allowing a
new recording. An unconfirmed stop is shown explicitly. Local draft editing
remains available while offline. When transcription capacity is full, new starts
are disabled but the recording owner can still stop.

Notifications use shadcn’s [Base UI Toast](https://ui.shadcn.com/docs/components/base/toast):
top-right on desktop and bottom-center below 768px. Capacity warnings and
rename/delete confirmations disappear after five seconds; request errors persist
until dismissed or resolved. Connection retries update one notification, and the
header’s Reconnect control remains available after dismissal. Draft-save retries
apply only to the selected conversation. Draft conflicts, recording-stop safety
warnings, and validation inside a rename/delete dialog stay inline.

Chat uses local Ollama Gemma; setup is documented in [CHAT.md](../../CHAT.md).
This visual port does not add the template's hosted model gateway, web search,
tool cards, or accounts.

## Verify

Run all repository checks from the root with `bun run check`. For web-only checks:

```bash
cd apps/web
bun run test
bun run build
bun run lint
```

Use Vitest through `bun run test`, not Bun's native `bun test`. Dependencies are
managed by the root `bun.lock`; this workspace has no separate lockfile.
Tests cover the rendered app with a backend fixture. Check desktop and mobile
layouts in a browser as well; jsdom does not measure layout or scrolling.
For the desktop sidebar, click the toggle twice without moving the pointer; it
must stay in the same spot throughout the animation. Check that the logo and
conversation title do not overlap it, including at the 768px breakpoint. Mobile
still uses the drawer and returns focus to the toggle when it closes.

## UI components

Use **shadcn/ui** with the existing `radix-nova` style for UI controls. Shared
components live in `src/components/ui`; compose them in app components rather
than introducing custom buttons, inputs, dialogs, or navigation controls. Add
components with `bunx --no-install shadcn add <component>` from this workspace.
Preserve existing components when the CLI asks whether to overwrite them.
Toast is the deliberate exception to the Radix style: `src/components/ui/toast.tsx`
is adapted from the `base-nova` registry and uses `@base-ui/react`, not Sonner.
Notification lifecycles live in `src/hooks/use-notifications.ts`. Keep toast text
short and task-focused: what happened, whether text is retained, and what to do
next. Do not display raw service errors, status codes, or terminal commands.
Keep the original error identity for notification dismissal and deduplication.

Use Lucide icons and semantic theme tokens in `src/index.css`. App layout lives
in `src/chat-ui.css`; the upstream typeset stylesheet owns Markdown typography.
The message scroller uses `@shadcn/react`, reset per selected conversation, with
user-message anchors and a scroll-to-end button. Keep OutLoud's conversation and
recording hooks rather than importing the template's AI SDK backend.
