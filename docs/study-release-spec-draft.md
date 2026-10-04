# Packaged study-focused macOS tester release

Status: draft, not published or agent-ready. Product scope and B's revision-queue direction are confirmed; the refined prototype, technical candidate, proposed test seams and ticket granularity below still need approval. Baseline: merged main `a43edd2`. No production release has been implemented by the prototype work.

## Problem Statement

OutLoud currently requires a developer checkout and tools to launch its Electron app. A nontechnical learner cannot install it, understand which local models are missing, or reliably recover from setup trouble. Study mode exists, but subject management, revision priorities, questions, answer feedback and ordinary chat do not yet form a coherent study-first journey.

## Solution

Provide an installable Apple Silicon macOS app for a small tester group. It opens to a Study home, offers resume and revision priorities, and lets learners create subjects and topics before downloading models. Guided, consent-based setup enables local chat, study feedback and voice input. A focused Study workspace shares the ordinary-chat composer and exposes supporting evidence without crowding the main task. Existing desktop data survives installation and upgrades. Sign and notarize the installer before nontechnical distribution.

## User Stories

1. As a tester, I want to install OutLoud into Applications without a source checkout, so I do not need developer tools.
2. As a tester, I want Finder launch to start the app and its own backend, so I do not need terminal commands.
3. As a tester, I want permission dialogs to identify OutLoud, so I understand which app needs microphone access.
4. As a learner, I want Study home to show my subjects, so my learning scope is visible immediately.
5. As a returning learner, I want Resume studying to restore my topic and last saved question, so I can continue without repeating setup.
6. As a learner, I want to create a subject and enter topics before model setup, so I can organize my syllabus while downloads are postponed.
7. As a learner, I want optional exam details to stay optional, so uncertainty about my exam does not block studying.
8. As a learner, I want assessed coverage and demonstrated understanding counted separately, so coverage is not mistaken for mastery.
9. As a learner, I want revision priorities to explain knowledge gaps and supplied exam importance, so I can make an informed choice.
10. As a learner, I want unknown exam importance and unassessed topics shown honestly, so the app does not invent certainty.
11. As a learner, I want a new conversation to start without a tutor question or intimidating heading, so I can begin on my own terms.
12. As a learner, I want to type an answer before a conversation exists, so the composer does not feel blocked.
13. As a learner, I want the first reviewed send to create its conversation, so I do not need an extra blank-chat step.
14. As a learner, I want to dictate into an editable draft, so I can review transcription before sending.
15. As a learner, I want Enter to send and Shift+Enter to add a newline without interrupting IME composition, so keyboard behavior is predictable.
16. As a learner, I want recording to remain bound to its originating conversation, so switching topics does not misroute my answer.
17. As a learner, I want recording and generation controls to remain independent, so stopping one does not stop the other.
18. As a learner, I want answer-specific feedback with source support and provisional status, so I can judge its reliability.
19. As a learner, I want assisted attempts distinguished from independent evidence, so hints do not falsely establish understanding.
20. As a learner, I want failed feedback to keep my answer and offer explicit retry, so failures do not cost my work or silently repeat generation.
21. As a learner, I want Explain this, Practice this, Move on and Finish studying to be clear, so I can choose how to address a gap.
22. As a learner, I want detailed assessment evidence available when needed, so the main question is not buried under history.
23. As a learner, I want to review syllabus/reference extraction before approval, so unreviewed material cannot change assessment support.
24. As a learner, I want edited or removed evidence to trigger reassessment correctly, so progress stays tied to current support.
25. As a learner, I want Study and Chat selectable in one conversation workspace with the same voice/text controls, so I do not need separate destinations.
26. As a tester, I want setup to detect a compatible existing Ollama service/model, so I do not duplicate installations or downloads.
27. As a tester, I want a native guided route to install/start Ollama if missing, so I do not need shell instructions.
28. As a tester, I want model terms and download requirements shown before consent, so I can choose whether to proceed.
29. As a tester, I want truthful download phases/byte progress, Cancel, Retry and Later, so setup failures are understandable and recoverable.
30. As a tester, I want unavailable study/chat/voice actions to explain the missing dependency and link to Settings, so I can fix the problem without persistent readiness indicators.
31. As a tester, I want first recording not to trigger a hidden Whisper download, so model setup is predictable.
32. As a tester, I want local inference to work after setup without network access, so the local-first claim is meaningful.
33. As an existing desktop user, I want saved conversations, drafts, study progress, uploads and delivery recovery preserved, so app replacement does not lose work.
34. As an existing desktop user, I want failed upgrades and unsupported newer data reported without reset, so errors never silently empty my library.
35. As a tester, I want closing/reopening to retain state and shut down only the app-owned backend, so another server or my Ollama service is unaffected.
36. As a tester, I want the signed, notarized download to pass Gatekeeper without workarounds, so normal installation is sufficient.
37. As a learner, I want subjects to group their conversations in the sidebar, so I can keep multiple independent conversations in one subject.
38. As a learner, I want new conversations to inherit subject topics, approved materials and progress, so I do not repeat subject setup.
39. As a learner, I want to select one or several topics within a conversation, so I can choose its scope while assessment remains attributable to a specific topic.
40. As a learner, I want each conversation to keep its own history and draft, so shared subject context does not merge my conversations.
41. As a learner, I want to request Practice when I choose, with its question shown as normal conversational text, so entering Study mode does not impose a quiz.

## Implementation Decisions

### Confirmed constraints

- Apple Silicon macOS first; small tester audience; cross-platform architecture retained.
- Study-first subject home and navigation. Study and Chat are selectable modes of one conversation workspace with a shared voice/text composer; separate sidebar destinations are superseded.
- Subjects group multiple conversations. Subject topics, approved material and progress are shared; sibling message histories and drafts are not merged. Conversations can select several topics, but each assessed answer remains attributable to a specific topic.
- Reuse existing subjects, syllabus, reference material, assessment evidence, topic assessments and revision priorities. Do not replace the assessment rules or imply validated grading accuracy beyond the existing evidence.
- Preserve app-owned backend ownership, per-user desktop data, independent conversation identity and exclusive microphone ownership.
- Keep manual organization available before model setup. Disable only actions whose dependencies are unavailable and explain what is missing.
- Models are excluded from the installer. Download consent and truthful capability checks are mandatory. Checks gate actions internally; they do not become global ready/not-ready badges.
- Preserve desktop data; browser-development data import is excluded.
- Sign and notarize before nontechnical distribution. No terminal installation, disabling Gatekeeper or quarantine removal in tester instructions.

### Technical candidate, awaiting approval and integration validation

- Ship the actual backend as a pinned PyInstaller onedir payload with Python/native dependencies and a provenance-tracked FFmpeg executable outside Electron's virtual archive. Preserve parent-stdin lease, authenticated readiness and owned-process shutdown semantics.
- Build the production renderer separately. Candidate: app-owned restricted loopback static serving at the existing desktop origin, preserving origin-scoped draft recovery and selections. No Vite/dev-server runtime dependency. A custom app protocol would need an explicit origin-data migration.
- Detect/reuse independently owned Ollama. Offer official native installation guidance when missing; do not acquire, restart, kill, replace or reconfigure an existing service. Bundle neither Ollama nor model weights in this milestone.
- Use bounded model detection and synthetic local capability checks, with dedicated setup operations for explicit model pulls. Progress is phase/layer/byte-aware, not a manufactured total percentage. Cancel affects only OutLoud's operation, not other clients' shared downloads.
- Provide a separate consented Whisper download into an explicit app-owned model directory, verified by checksum before atomic activation. Load the validated checkpoint without a surprise first-recording download.
- Preserve existing desktop data/profile paths. Add tested, consistent backups and supported-schema upgrade/refusal behavior where needed; never silently reset on upgrade failure.
- Use minimal executable-specific entitlements and inside-out native signing. Confirm actual packaged microphone attribution and hardened runtime loads before adding exceptions.
- Keep unchanged assessment rules: sufficient independent supported evidence for established understanding; hinted answers do not establish it; unsupported feedback remains provisional; changes to coverage/reference/evidence invalidate dependent judgments.

### Selected UI direction

- Use B's Revision queue and expanded desktop sidebar with expandable subject groups, nested conversation titles, New conversation within a subject and New subject. Pin Settings at the bottom independently of group/conversation scrolling. Remove separate Study/Chat navigation entries.
- A single conversation workspace offers a Study/Chat mode selector, a topic selector populated from its subject, and one shared composer. Subject context is inherited without repeating setup. The revised in-memory prototype demonstrates this refinement; production integration remains unimplemented.
- Confirmed transition rules: mode switches preserve the current conversation, draft and saved question; prior messages retain their mode and topic attribution, and Chat messages are not retroactively assessed. Relevant explanations/hints delivered in Chat make the corresponding Study attempt assisted; merely switching modes does not. Retries must preserve that assistance, and completing an assisted attempt must not permanently prevent future independent attempts.
- Production must associate each accepted turn with its actual mode, assessment topic/question, selected-topic scope and applicable evidence/reference context. Do not reinterpret accepted requests, retries or old messages using a later mode/topic selection. Track delivered guidance rather than infer assistance merely from a user's request or the prototype's keyword heuristic.
- Topic changes must not silently reinterpret an unsent answer or redirect an active recording. Study and Chat use the same composer; the prototype blocks topic changes with a draft and mode/conversation changes during simulated recording. Carry these recovery/routing cases into production tests.
- Use the selected subject name as the home heading, distinguish assessed coverage from demonstrated understanding, and keep one next-topic action above the ordered revision queue. Do not repeat subject navigation in tabs.
- No persistent readiness indicators, Local badge, decorative eyebrow headings, motivational slogans or static study-step strip. Every heading identifies content. Additional text must explain an action, result, evidence or recoverable error.
- Keep setup in Settings. Show missing dependencies or connection failures only where they affect an attempted/available action; retain download progress, consent, cancellation and explicit retries.
- New conversations open quietly in both modes: no automatic question, greeting question or quiz heading. Keep a neutral composer placeholder. Practice is opt-in; show requested questions as normal conversational text, one current practice question at a time. Free-form Study discussion is not assessed against hidden prompts, and choosing topics or switching modes must not silently generate a question. Preserve existing history and requested practice on resume. Keep management/evidence details in controlled panels. Minimal copy must retain provisional-feedback and assisted/independent distinctions. The prototype code is not production code and must be rewritten against real endpoints and accessible components.

## Testing Decisions

Proposed seams for learner approval before publishing:

1. **Packaged desktop app:** installed artifact and rendered UI driven as a learner would use it. Cover production launch, no-development-tool runtime, setup and capability states, native lifecycle, data upgrade/reopen, renderer security and unrelated-process ownership. Real-device/clean-machine/Gatekeeper checks complement automation; mocks cannot prove microphone attribution or trusted distribution.
2. **Rendered Study/Chat UI through existing backend boundaries:** subject creation before models, resume, reviewed drafts/first send, dictation routing, setup recovery, question/feedback/evidence/reference review, progress semantics, keyboard behavior and ordinary-chat parity. Include nested conversation creation/first send, independent drafts/history, inherited subject context, topic scope changes without draft reinterpretation, mode switching with a saved question, and delivered Chat guidance followed by an assisted Study answer. Assert that mode toggles alone do not add assistance, failed retries retain original context, Chat messages are not retroactively graded and new independent attempts are possible. Verify no automatic question on opening, mode switching or topic selection, no intimidating quiz heading, no hidden-prompt assessment for free-form discussion, and explicit Practice revealing a normal-text question. Prior art: existing App, Study, voice-level and permission suites.
3. **Setup/backend HTTP and external-model boundaries:** actual HTTP/progress contracts with controlled Ollama/download/permission failures at external boundaries. Cover checksum/atomic activation, terminal streaming errors, cancellation without killing shared services, readiness versus availability and migration failures. Prior art: existing backend HTTP, persistence, recovery and desktop lifecycle suites.

Test externally visible outcomes, not private state or mocks of internal collaborators. Use red-green vertical slices at approved seams. Retain narrow real-model smoke checks and label their limits. A health response is not voice/model readiness, relocation is not a clean-machine test, and ad-hoc signing is not a notarized release.

Release acceptance includes a populated current-desktop upgrade fixture, an interrupted/failed upgrade, real spoken dictation and study/chat inference, closing during transcription, a quarantined signed download, and offline launch/inference after setup. Never use learner content in setup probes.

## Out of Scope

- Public release, automatic updates, Intel installer validation, and Windows/Linux installers in this milestone.
- Browser-development data import or silent merging of desktop and browser libraries.
- Bundled model weights, private managed Ollama runtime, cloud inference, or changes to user-owned model/service configuration.
- New global recording shortcuts, native speech output, query execution, handwriting extraction, or broader grading guarantees.
- Redesigning the underlying assessment model, removing existing draft/conflict/recording safeguards, or shipping prototype variants/switchers.

## Further Notes

- Packaging spike: the actual relocated arm64 backend passes native imports, FFmpeg WAV decode, Whisper mel/tokenizer, PDF/image processing, readiness, and conversation persistence across restart with a stripped environment. The unpacked payload is about 734 MiB, excluding model weights.
- All 191 bundled Mach-O files have an arm64 slice; the audit found no non-system absolute load paths. This does not establish all delayed native/JIT/model paths.
- Still unvalidated: Electron bundle integration, minimum macOS compatibility, clean-machine isolation, microphone attribution/capture, real inference, existing-data upgrade, trusted signing/notarization and redistribution clearance.
- Source documents: [confirmed direction](release-design.md), [primary-source packaging research](research/macos-packaged-release.md), [reproducible packaging evidence](testing/packaged-backend-spike.md), [UI prototype and walkthrough](study-release-prototype.md).
- Signing requires human-provisioned Developer ID identity/private key and notary credentials. Keep secrets outside source and logs. Account/permission/device gates remain explicit release blockers.

## Proposed tracer-bullet tickets — not yet published

| # | Ticket | Blocked by | Demoable result |
|---|---|---|---|
| 1 | Launch the production desktop UI with a bundled backend | None | An internal arm64 app opens outside the checkout, saves a conversation and shuts down/reopens its owned backend without developer tools. |
| 2 | Preserve existing desktop data across packaged upgrades | 1 | A populated current desktop fixture keeps conversations, profile drafts, subjects/progress and pending delivery; failed/unsupported upgrades never reset data. |
| 3 | Open to Study home and resume a saved topic | None | B's minimal revision-queue home uses expandable subject groups and nested independent conversations, inherited subject context, bottom Settings, no readiness indicators or decorative headings, distinct progress counts and revision priorities. Manual subject/topic creation works without models. |
| 4 | Study a topic in the focused shared voice/text workspace | 3 | One workspace supports Study/Chat selection and one or several selected subject topics, with per-topic assessment attribution. Topic resume, quiet learner-led entry, opt-in practice, reviewed composer, honest feedback, assisted/independent evidence and finish/retry flows work without losing drafts/history when switching modes or grading discussion against an unseen question. |
| 5 | Guide Ollama setup and enable validated local chat/study | 1 | Native install/reuse guidance, consented Gemma pull, truthful progress/cancel/retry/later, and validated local chat/study readiness work without terminal commands or service takeover. |
| 6 | Set up Whisper and dictate from the packaged app | 1 | Consented verified voice-model setup, OutLoud microphone consent/denial recovery, real dictation to the correct draft, and independent recording/generation controls work. |
| 7 | Review study material and inspect evidence without leaving the workflow | 4 | Existing syllabus/reference approval and invalidation semantics are exposed in focused panels, with accessible review, source support and assessment history. |
| 8 | Produce a traceable signed/notarized arm64 installer | 1 | A versioned app/DMG has audited runtime notices/source provenance, consistent native signatures, notarization and stapling; no untrusted workarounds required. |
| 9 | Validate the combined tester release on a clean Mac | 2, 4, 5, 6, 7, 8 | A nontechnical tester installs the final signed artifact, organizes subjects before setup, studies/dictates, uses ordinary Chat, works offline after setup, and reopens with data intact. |

Approve or adjust the refined B prototype, candidate architecture, test seams and ticket breakdown before publishing GitHub issues. Tickets must link to the preserved prototype commit and use native dependency edges; the final tester release stays blocked until all hard gates have actual evidence.
