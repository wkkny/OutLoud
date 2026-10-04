# Study release UI prototype

Status: runnable exploration; no layout has been approved. Prototype branch: `prototype/study-release`, based on merged main `a43edd2`.

## Question

Which information hierarchy makes it easiest to choose the next topic, resume a saved study conversation, review answer-specific feedback, and finish a study session without confusing assessment coverage with demonstrated understanding?

The prototype is mounted on the existing app route behind a development-only query parameter. It uses the existing React/shadcn components and bundled Geist font. It does not contact the backend, models or microphone, and all mutations are in memory. This isolates the UI decision from setup and assessment correctness. Production UI and backend behavior remain unchanged.

## Run

```sh
bun install --frozen-lockfile
bun run prototype:study
```

Open `http://127.0.0.1:5175/?prototype=study-release&variant=A`. The prototype needs no Python backend, model or microphone permission. Port 5175 must be free.

- **A — Study dashboard:** persistent app sidebar, subject tabs, separate assessment/understanding counts, a prominent resume card, materials card, and revision list.
- **B — Revision queue:** compact navigation rail, one recommended next action, ordered topic list, and a linear study-step strip.
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
8. Open Complete setup; consent to the simulated download, cancel/retry it, or choose Later. The simulation requires a separate verification action after download completion, rather than conflating download with readiness.
9. Select Backend offline. Compose a draft in Chat; generation/recording stay blocked while typing remains possible.
10. Inspect demo state. It includes layout, screen, subject/topic, readiness, draft, recording, feedback flags, and topic evidence counts.

## Observed browser checks

On 2026-10-04, the collaborative browser exercised:

- A home → Resume → typed answer → Enter → visible reviewed answer and simulated feedback, with the composer cleared.
- No backend/model HTTP requests in the prototype path.
- Layout switching updates the URL through A, B and C.
- Missing-model scenario → manual Computer Networks subject with Routing/TCP topics → subject created, 0/2 assessed, model-dependent topic actions blocked.
- A at 390 CSS-pixel width had no horizontal page overflow.
- Web TypeScript/build and lint pass. The production build omits the prototype import/chunks after the development-only gate is eliminated.
- Existing web suite: 107 tests passed. No permanent prototype tests were added; these checks establish runnable exploration, not production behavior or usability approval.

## Limitations and next decision

This is not a production implementation, assessment-quality experiment, accessibility completion, real setup workflow, speech test or persistence test. Feedback, evidence dates, source text and model/download state are fixtures. Model-dependent readiness is simplified into scenarios; production needs separate capabilities and truthful phase/byte progress.

The modal panels lack production dialog focus management and the prototype intentionally skips automated tests and robust recovery. Rewrite the chosen design against the actual API and agreed test seams; do not merge these variants or their switcher into main.

Recommended starting candidate: **A**, borrowing **C's optional reference/evidence panel** for focused study. The learner must choose/approve the layout before this is treated as a settled UI decision. Preserve all variants on the prototype branch as the primary source, and link this document/commit from the implementation issue.
