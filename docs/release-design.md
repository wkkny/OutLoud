# Packaged study-focused release

Status: product direction and B's revision-queue layout selected. The refined prototype needs visual review; technical candidates, test seams and ticket breakdown remain pending approval.

## Confirmed release boundaries

- First audience: a small group of testers, rather than a public release.
- First supported platform: macOS. Preserve the cross-platform architecture; Windows and Linux installer validation are outside this milestone.
- Installation must not require a source checkout, Bun, uv, or terminal commands. Bundle the Python backend and required runtime dependencies.
- Large models are not included in the installer. Provide guided model setup, visible download progress, and accurate readiness states. Whether OutLoud manages Ollama itself needs a feasibility check before committing to an implementation.
- OutLoud is study-focused, with ordinary chat still available. The main journey is subject selection, revision priorities, studying a topic, and reviewing progress.
- Improve study workflow and navigation before visual polish. Study and ordinary chat share voice capture and composer behavior.
- Use B's revision queue with an expanded desktop sidebar and Settings at the bottom. No global readiness indicators or decorative eyebrow headings. Headings name content; every other piece of text must help the learner act or understand an outcome.
- Refine the existing study implementation rather than replace its evidence and persistence model.

## Existing constraints

The merged Electron implementation is development-only and currently depends on the repository Python environment, FFmpeg, Ollama, and model downloads. The packaged app must replace that development launch path with a production renderer and packaged backend.

Study behavior and terminology are recorded in `docs/study-mode-design.md`, `docs/study-mode.md`, and `GLOSSARY.md` on main. Preserve the distinction between assessed coverage and demonstrated understanding, independent and hinted answers, and provisional and reference-supported feedback.

Desktop owns its backend and separate per-user saved data (ADR 0002 on main). Packaging must not silently attach to or terminate another backend, change data ownership, or lose existing desktop data.

## Confirmed experience and distribution

- Opening the app shows a Study home with subjects, Resume studying, and revision priorities. Study and Chat are selectable modes in one conversation workspace, not separate sidebar destinations. This supersedes the earlier separate-Chat navigation decision. Returning learners can resume their last topic without repeating setup.
- Model setup can be postponed. Users can explore, create subjects, and enter topics manually before models are ready. Model-dependent actions explain what is missing at the affected action and link to Settings. Do not add global readiness badges or banners.
- Downloads require consent, show progress, and can be retried. Backend connectivity alone does not establish model readiness.
- One focused workspace combines subject/topic context, conversation and the shared voice/text composer. Both modes open with an empty message area, not a tutor question or intimidating heading. Questions are optional and requested through the conversation, not a separate Practice button. They appear as normal tutor replies, not hero headings or additional quiz cards. Detailed evidence and subject management use expandable panels.
- Free-form Study messages before requesting practice are discussion, not answers to a hidden quiz. Do not automatically generate a question or assess those messages against an unseen prompt. Preserve existing conversation history and already-requested practice when resuming.
- Feedback remains answer-specific and shows reference support and provisional status. The UI does not imply more grading accuracy than existing assessment validation establishes.
- Preserve existing desktop conversations and study progress with tested schema upgrades. Browser-development data import is outside this release; do not silently combine the separate stores.
- Validate Apple Silicon first. Intel installer validation and automatic updates are outside this release.
- Produce an installable build early, but require signing and notarization before distributing it to nontechnical testers. Security workarounds are not the intended installation experience.

## Subject grouping refinement

The learner wants each subject to be the sidebar group/folder, with multiple conversations listed beneath it. Keep Subject as the domain term; folder describes the presentation, not a separate entity. Subject context and available topics belong to the subject so new conversations do not require repeated setup. Conversations select their topic focus from that subject.

The learner accepted one or several selected topics per conversation, with each assessed answer tied to a specific topic. Conversations share the subject's topics, approved materials and progress, but keep independent message histories and drafts. They do not automatically consume all sibling conversation transcripts.

Study and Chat should be modes of the same workspace, using one composer rather than separate components/pages. Confirmed switching behavior preserves the conversation, draft and saved study question; previous messages retain their original mode and Chat messages are not retroactively assessed. The learner confirmed that relevant explanations or hints received in Chat make the corresponding Study attempt assisted. Merely switching modes does not. A fresh independent attempt remains possible after that assisted attempt; assistance must not become a permanent penalty.

The existing backend already supplies subject material/progress to study conversations, but each conversation is currently bound to one topic. The revised prototype demonstrates nested conversation navigation, multiple selected topics and mode transitions with in-memory data. Production needs explicit persistence, request-context snapshots, source applicability and delivered-guidance tracking; the throwaway demo is not that implementation. Preserve the minimal B direction, bottom Settings and stable selection layout.

## Remaining empirical questions

- How to package the Python backend, native audio libraries, FFmpeg, and production renderer reliably on Apple Silicon.
- Whether to manage Ollama or guide installation of an independently owned service, without commandeering an existing installation.
- Whether the proposed navigation and study workspace work well in a runnable prototype.
- Whether packaged native microphone permissions attribute correctly and real recording/transcription work.
- Whether the release preserves existing desktop data through installation and upgrade.

## Validation before implementation commitments

- Prove packaged Python/native audio dependencies and a production renderer run without repository or development tools.
- Check model installation/detection and Ollama lifecycle options against primary documentation before selecting ownership behavior.
- Validate a visual prototype of the complete study journey before implementing the redesign.
- Test real packaged microphone permission and recording behavior on the target Mac; development Electron permission behavior is not sufficient evidence.

## Exploration results

- The actual frozen arm64 backend passed a relocated, stripped-environment probe, including native dependencies, FFmpeg WAV decoding, Whisper mel/tokenizer, PDF/image processing, worker readiness and draft persistence across restart. All 191 Mach-O files have an arm64 slice; the unpacked payload is about 734 MiB without models. See `docs/testing/packaged-backend-spike.md`. This is not clean-machine, Electron-bundle, microphone, model-inference or signing validation.
- Primary-source research recommends PyInstaller onedir plus a bundled provenance-tracked FFmpeg executable and guided external Ollama installation/reuse. Production renderer serving must preserve or explicitly migrate origin-scoped recovery. See `docs/research/macos-packaged-release.md`; candidate decisions remain conditional on integration gates.
- Three clickable UI variants are available on the throwaway `prototype/study-release` branch: Study dashboard, Revision queue and Subject notebook. The learner selected B with an expanded sidebar, bottom Settings control and minimal copy, without readiness indicators or decorative headings. The demo is development-only and never accesses real models, backend data or microphone. See `docs/study-release-prototype.md`.
- A release spec and nine dependency-linked tracer-bullet tickets are drafted in `docs/study-release-spec-draft.md`. They are not published or agent-ready until the refinement, proposed test seams and breakdown are approved.

## Suggested engineering route

Review the UI prototype and approve the release spec's candidate architecture, test seams and ticket breakdown. Publish one release spec and dependency-linked GitHub tickets, then implement vertical slices with tests and standards/spec reviews. Validate the final signed/notarized installer on a clean tester environment before distribution. Automatic updates and additional platforms remain out of scope.
