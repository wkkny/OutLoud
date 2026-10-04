# Study release UI prototype

Status: the learner selected B (Revision queue), then confirmed subject folders, independent nested conversations, multiple selectable topics, and a shared Study/Chat workspace. This revised prototype is ready for visual review. It is not production integration. Branch: `prototype/study-release`, based on merged main `a43edd2`.

## Question

Can a minimal subject-first workspace make it easy to resume or start a conversation, choose its topics, and switch between Study and Chat without losing drafts or confusing assisted attempts with independent evidence?

The prototype uses the existing React/shadcn components and bundled Geist font, mounted behind a development-only query parameter. It never contacts the backend, models, microphone or persistent storage. Reloading resets all demo changes. The production app's behavior is unchanged.

## Run

```sh
bun install --frozen-lockfile
bun run prototype:study
```

Open `http://127.0.0.1:5175/?prototype=study-release&variant=B`. Port 5175 must be free; Python, models and microphone permission are unnecessary.

The floating demo bar changes `?variant=A|B|C`, scenarios and feedback fixtures. Arrow keys also switch variants outside inputs, buttons and dialogs. Switching layouts preserves in-memory conversation state.

- **A — Study dashboard:** subject overview with a next-topic card and conversation cards beside the revision list.
- **B — Revision queue (selected):** subject overview, one next-topic action and an ordered topic list, with expandable subject folders and nested conversations in the sidebar.
- **C — Subject notebook:** syllabus-first overview and a reference panel beside the conversation.

The original layouts are preserved in `6968624`; the expanded/minimal B refinement in `da685e8`; and its selection-layout fix in `e029cac`.

## Selected direction

- Subjects are the sidebar groups/folders. Conversation titles, not topic names, are nested beneath them. A subject holds the topic catalog, approved material and progress; sibling conversations do not share transcripts or drafts.
- Study and Chat are modes of one conversation workspace with one composer. No separate mode destinations in the sidebar. Mode switches preserve the conversation, draft and saved question, and old turns keep their original mode and assessment topic.
- Conversations can select one or several topics. Both modes start with an empty message area and neutral composer, with no opening question, quiz heading or replacement greeting. There is no Practice button. Asking for a question in the composer produces an ordinary tutor reply about the current focus, not a separate quiz card. Free-form Study messages are discussion, not assessment against a hidden prompt. Explicit practice answers remain attributable to one topic. Topic changes cannot reinterpret an unsent message; the demo blocks changing its focus until that draft is sent or cleared.
- Relevant help delivered in Chat makes the corresponding Study attempt assisted. Mode toggles alone do not. Retries/repeated answers keep their assistance; starting a fresh question after completing the assisted attempt can begin an independent attempt.
- Settings stays at the sidebar bottom independently of conversation-list scrolling. Desktop navigation is expanded; narrow screens open the same folders in a drawer.
- No global readiness indicators, decorative eyebrows, motivational slogans, duplicate subject tabs or static study-step strip. Headings name content; other text must explain an action, result, evidence or failure. Missing dependencies appear beside affected actions, with a route to Settings.

See [ADR 0003](adr/0003-subject-context-and-conversation-modes.md) and [the release draft](study-release-spec-draft.md). Rewrite against actual endpoints and approved test seams; do not promote throwaway code or ship the demo controls.

## Walkthrough

1. Expand/collapse DBMS. Open Normalization practice or Exam revision. Clicking a subject name returns to its overview without changing the folder's text metrics.
2. Open Exam revision: Normalization and Transactions are already selected. Topics opens the subject's topic catalog; add Indexing, then Apply topics. Focus chooses a topic without generating a question.
3. The initial message area is empty in either mode. Type an unsent draft, switch to Chat and back, and keep that draft. Merely switching generates neither a question nor assistance. A previously requested practice question remains saved.
4. Ask Chat to explain a selected topic. The demo supplies guidance for it. Return to Study and send “Ask me a question”; its next answer is assisted. Discussion before requesting a question is not assessment evidence. Explain normalization is also available after a conversation has begun, without sending unrelated composer text.
5. Ask “Ask me another question” after the reviewed assisted attempt. A new question can begin an independent attempt. Choosing a new practice question before answering must not bypass pending assistance. No new progress is awarded in this demo.
6. Leave different drafts in Normalization practice and Exam revision. Switch conversations: each keeps its own draft, mode and message history. Subject material and the topic catalog remain shared.
7. Choose New conversation within DBMS. It inherits the subject context and available topics. Before the first send it is an in-memory pending draft, not another saved sidebar entry. The first reviewed send lists it under DBMS. Reopening New conversation resumes an existing pending draft rather than discarding it.
8. Dictate, then Stop. Simulated text enters the current draft without a microphone. Mode/topic/conversation navigation is disabled during capture so the target cannot change. Send remains separate from recording.
9. Finish studying. Study pauses with its draft intact; Chat is still available in the same conversation. Return to Study and Resume without creating a new conversation.
10. Toggle Provisional or Feedback failed in the demo bar. Unsupported guidance does not claim established understanding. Failed Study feedback retains the answer and its original context, with explicit Retry feedback.
11. Open Materials. Editing the shared reference makes it pending until approval. Assessment evidence lists Study attempts across the subject's conversations with their topic and assistance status; Chat turns are not assessment evidence.
12. Select First launch. Create Computer Networks with Routing/TCP. Subject creation and organization remain available, while model-dependent actions are blocked locally. Open bottom Settings for simulated consent/download/cancel/retry/verification/Later.
13. At a narrow width, open Subjects to reach folders, conversations and bottom Settings. Inspect demo state in the lab bar to see subjects, conversation scope, questions, assistance flags, original-mode turns and independent drafts.

## Observed browser checks

The collaborative browser exercised these paths on 2026-10-04:

- Initial variants: home/resume/typed answer, no backend/model requests, URL switching, manual subject creation without models and a 390px overflow check.
- Expanded B selection bug: selected-only weight 550 wrapped DBMS, growing its row from 38px to 56px and shifting subsequent rows by 18px. Removing that weight gave zero selection shift. The later grouped-sidebar revision also passed bounding-box comparisons when selecting Operating Systems and DBMS without changing expansion.
- Earlier grouped revision: Exam revision opened with two selected topics and exactly one composer. Study → Chat retained its ID, unsent draft and original Normalization question; assistance remained empty.
- Explain normalization → Study → Send recorded a Chat guidance turn and a distinct assisted Study answer attributed to Normalization. The sibling conversation remained unchanged; the composer cleared and no backend/model requests occurred.
- Topics → add Indexing → Apply preserved the question and yielded three selected topics. Different drafts in Exam revision and Normalization practice survived navigation, and Exam revision retained its two turns.
- New conversation inherited DBMS and its topic catalog, remained pending before sending, then Enter in Chat saved General DBMS discussion as the third nested conversation. A non-guidance Chat turn did not mark assistance.
- First launch → Computer Networks with Routing/TCP produced an expanded folder with 0 assessed topics. Manual creation stayed enabled; model-dependent study was blocked.
- Earlier Practice-button revision: requesting practice before answering retained pending Chat assistance. After the assisted answer, Practice created a fresh question eligible for an independent attempt while the old turn stayed assisted and the Chat turn retained its mode.
- During simulated recording, both modes, the topic selector, conversation navigation and Send were disabled while Stop remained available. No real microphone was accessed.
- At 390px, the shared workspace had one composer and no horizontal overflow. The Subjects drawer opened/closed, and bottom Settings remained visible and unobscured.
- Earlier learner-led opening revision: Exam revision opened with zero stored questions, zero question headings, an empty message area and one neutral composer in both Study and Chat, including after switching between them. A first free-form Study message sent without generating a question, an assessment label or a hidden quiz. Clicking Practice then displayed its requested question as a paragraph, still without a question heading.
- Practice-control removal: the empty Study opening has only Dictate and Send in the composer toolbar. “Ask me a question about normalization” produces a normal tutor reply, with no question heading or duplicate quiz card. The request itself is not graded.
- Web TypeScript/build, lint and the 107 existing web tests pass. The production bundle omits prototype JavaScript. No permanent prototype test suite was added; these checks establish runnable exploration, not production assessment correctness or usability approval.

## Limitations

All responses, source support, downloads, model states and starting progress are fixtures. Even a labelled independent answer is not a validated judgment, and the demo never updates saved topic progress. Reference applicability is conservatively simulated for the supplied Normalization excerpt; other topics remain provisional.

The simulation detects simple guidance words and selected topic names, with an explicit Explain shortcut for a deterministic walkthrough. Its question-request matcher supports phrases such as “Ask me a question”, “Ask me another question” and “Quiz me” in Study mode; this is a bounded demo, not general language understanding. Production must record actual delivered help and its topic scope, not copy this heuristic or penalize failed requests. Persistence, material-revision invalidation, minimum supported platforms, asynchronous generation/cancellation and durable request recovery need production tests.

The modal panels and mobile drawer do not provide complete production focus management. This is not an accessibility completion, setup/inference test, real recording test, data migration, packaged installer or trusted-distribution validation. Keep the disclaimer and lab controls while reviewing; exclude them from the implemented product.
