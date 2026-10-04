# Study release UI prototype

Status: learner selected B (Revision queue), with an expanded desktop sidebar, Settings at the bottom, no readiness indicators and no decorative headings. This revision is ready for visual review. Prototype branch: `prototype/study-release`, based on merged main `a43edd2`.

## Question

Which information hierarchy makes it easiest to choose the next topic, resume a saved study conversation, review answer-specific feedback, and finish a study session without confusing assessment coverage with demonstrated understanding?

The prototype is mounted on the existing app route behind a development-only query parameter. It uses the existing React/shadcn components and bundled Geist font. It does not contact the backend, models or microphone, and all mutations are in memory. This isolates the UI decision from setup and assessment correctness. Production UI and backend behavior remain unchanged.

## Run

```sh
bun install --frozen-lockfile
bun run prototype:study
```

Open `http://127.0.0.1:5175/?prototype=study-release&variant=B`. The prototype needs no Python backend, model or microphone permission. Port 5175 must be free.

- **A — Study dashboard:** persistent app sidebar, subject tabs, separate assessment/understanding counts, a prominent resume card, materials card, and revision list.
- **B — Revision queue (selected):** expanded Study/Chat and subject navigation, Settings pinned at the sidebar bottom, one next-topic action, and an ordered topic list. The subject name is the page heading. No duplicate subject tabs, readiness badges, decorative eyebrows, motivational copy or study-step strip.
- **C — Subject notebook:** persistent subject/syllabus index, a subject notebook with evidence history, and a study workspace with the reference excerpt alongside the conversation.

The bottom switcher updates `?variant=A|B|C`; left/right arrow keys also cycle layouts outside editable controls. Switching layouts preserves the current demo state; reloading resets it.

## Walkthrough

1. Compare home screens A, B and C. Distinguish topics assessed from understanding demonstrated.
2. Resume Normalization. Type an answer, press Enter, and inspect the clearly simulated feedback and follow-up question. Shift+Enter inserts a newline; IME composition does not send.
3. Click Dictate, then Stop. The prototype inserts sample dictation without accessing a microphone. Review it before sending.
4. Try Explain this, Practice this, Move on and Finish studying. Read the assisted-answer caveat and session summary. The prototype never awards new progress.
5. Toggle Provisional and Feedback failed in the switcher. Observe that provisional guidance does not establish a gap and failed feedback preserves the reviewed answer with explicit retry.
6. Open the evidence and material-review panels. Edit a reference: it becomes pending review until approved. Syllabus scope and reference support remain distinct.
7. Select First launch. Models are missing, but create a subject and manually enter topics. New topics remain not assessed. Model-dependent study actions explain setup is needed.
8. Open Settings at the bottom of the sidebar; consent to the simulated download, cancel/retry it, or choose Later. The simulation requires a separate verification action after download completion, rather than conflating download with readiness.
9. Select Backend offline. Compose a draft in Chat; generation/recording stay blocked while typing remains possible.
10. Inspect demo state. It includes layout, screen, subject/topic, readiness, draft, recording, feedback flags, and topic evidence counts.

## Observed browser checks

On 2026-10-04, the collaborative browser exercised:

- A home → Resume → typed answer → Enter → visible reviewed answer and simulated feedback, with the composer cleared.
- No backend/model HTTP requests in the prototype path.
- Layout switching updates the URL through A, B and C.
- Missing-model scenario → manual Computer Networks subject with Routing/TCP topics → subject created, 0/2 assessed, model-dependent topic actions blocked.
- A and the refined B at 390 CSS-pixel width had no horizontal page overflow; B's Settings icon remained visible and clickable.
- Refined B: expanded sidebar and bottom Settings control opened the model-settings dialog. Continue studying → typed answer → Enter preserved the answer, displayed feedback and cleared the composer. No decorative-eyebrow or global-readiness elements remained.
- Missing models in refined B disabled dependent study actions, left New subject enabled, and showed setup guidance only beside the affected action.
- Subject-selection layout regression: switching Operating Systems → DBMS changed its font weight from 400 to 550, wrapping the name and increasing row height from 38px to 56px. Browser bounding-box checks caught an 18px shift in subsequent rows. Removing the selected-only font weight leaves the color/background highlight and produces zero height/position changes for DBMS, Operating Systems and New subject at 1280px width. Retain this selection-stability check in production UI validation; the prototype has no permanent test suite.
- Web TypeScript/build and lint pass. The production build omits the prototype import/chunks after the development-only gate is eliminated.
- Existing web suite: 107 tests passed. No permanent prototype tests were added; these checks establish runnable exploration, not production behavior or usability approval.

## Limitations and next decision

This is not a production implementation, assessment-quality experiment, accessibility completion, real setup workflow, speech test or persistence test. Feedback, evidence dates, source text and model/download state are fixtures. Model-dependent readiness is simplified into scenarios; production needs separate capabilities and truthful phase/byte progress.

The modal panels lack production dialog focus management and the prototype intentionally skips automated tests and robust recovery. Rewrite the chosen design against the actual API and agreed test seams; do not merge these variants or their switcher into main.

## Selected direction

The learner chose **B**, rather than the earlier A/C recommendation. Keep its next-topic action and revision queue, but use an expanded desktop sidebar with Settings at the bottom. Remove global readiness badges and decorative eyebrow headings. Each heading must identify actual content; supporting text should explain an action, evidence or a failure, not decorate the screen.

The revision removes the duplicate subject tabs, top status bar, Local badge, ready indicators, motivational slogans and static study-step strip. Subject selection and creation live in the sidebar. Settings remains reachable when the subject list scrolls. Model checks still gate dependent actions internally; missing-model and connection problems appear beside the affected action, with a route to Settings. Minimal presentation must not discard provisional-feedback or independent-evidence distinctions.

The prototype disclaimer and floating demo controls remain separate from the proposed product UI. They must not ship. The original variants are preserved in commit `6968624`. Rewrite the chosen design against real APIs and approved test seams rather than promote throwaway code.
