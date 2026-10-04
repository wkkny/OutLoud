# Study mode design interview

Status: confirmed for implementation on 2026-10-04. This records the agreed product design and prototype validation agenda; it is not an implementation spec.

## Confirmed decisions

- First use case: learning DBMS for exams.
- The learner supplies a subject and a topic list or syllabus to define study scope.
- Assessment starts with the learner explaining a topic, followed by targeted model questions that test understanding and application.
- Feedback follows the attempt. Answers given independently are distinguished from answers given after hints.
- The first version uses reviewed voice input and text replies.
- Knowledge gaps and exam importance are shown separately and combined into a revision order. Exam importance uses learner-supplied weights; unavailable exam importance is explicitly unknown.
- Support PDF and image uploads with distinct syllabus and reference-material roles. The syllabus defines coverage; reference material helps evaluate answers. The learner reviews extracted content before use. Processing and resource limits will be informed by prototype validation.
- Report topic-level outcomes: demonstrated understanding, partial understanding, needs revision, and not assessed. Show supporting answers and gaps; untested topics remain not assessed.
- Retain study progress per subject across conversations and days, including assessment dates. Reassessment supplies new evidence that can update earlier judgments.
- Start a study conversation through Choose a topic or Study next recommendation. Ask one question at a time, beginning with the learner's explanation.
- After identifying a gap, offer Explain this, Practice this, and Move on. Use a fresh question to reassess independent understanding after teaching or hints.
- Approved reference material is the assessment baseline. Flag conflicting references for review. When references are insufficient, general-knowledge feedback is provisional; uncertain judgments are not recorded as established gaps.
- Ask for exam type with a Not sure option. Course/level, exam date, and topic weights are optional and editable. Incomplete exam details do not block studying.
- Add a Study area with subjects, topics, and revision priorities. Selecting a topic opens its study conversation. Preserve ordinary chat and support the shared browser and Electron UI.
- First-version uploads cover printed PDFs and clear photos/scans. Allow selection of relevant pages from larger documents and review of extracted content. Handwriting support is deferred until accuracy has been tested.
- Preserve topic progress on rename. New topics are not assessed. Substantive coverage changes require reassessment while retaining earlier evidence. Removed topics leave the active syllabus but remain in historical assessments.
- Give answer-specific feedback after each attempt. Update topic assessments after sufficient evidence and provide a summary when the learner finishes studying. Distinguish syllabus coverage assessed from understanding demonstrated.
- Support multiple-choice, written explanations, and applied questions through conversation, matched to the chosen exam type. Evaluate SQL answers as text in the first version; query execution is deferred.
- Resume interrupted study conversations from the last saved step. Preserve learner answers, visibly distinguish incomplete feedback, and offer explicit retry. Only completed assessments update progress.
- Deleting a conversation removes its answer evidence. Recalculate dependent assessments from remaining evidence or mark them for reassessment. Removing reference material invalidates judgments that depend on it. Deleting a subject removes its study conversations, progress, and uploads after confirmation.
- Validate a small DBMS prototype using the existing local Gemma model before implementing the full study system. Test syllabus extraction and assessment against reviewed correct, partial, incorrect, and hinted answers. Use results to set evidence requirements and upload limits. Resolve inadequate assessment quality before building the full progress system.

## Verified upload capabilities

The configured [gemma3:4b model supports text and image input](https://ollama.com/library/gemma3:4b). [Ollama vision requests](https://docs.ollama.com/capabilities/vision) carry images alongside message text. OutLoud currently sends text only and has no upload flow.

The [Ollama chat schema](https://docs.ollama.com/api/chat) exposes text and images, rather than native PDF documents. PDF handling therefore requires application-side processing into text or page images. Extraction accuracy for the learner's files and resource limits remain unvalidated.

## Prototype validation agenda

These are empirical questions, rather than unresolved product preferences. If validation changes the agreed scope, return to the learner for a decision.

- Extract a small DBMS syllabus from representative printed PDFs and clear photos/scans; compare extracted topics and text against reviewed source content.
- Exercise one topic's explanation, follow-up questions, feedback, teaching/practice, and fresh reassessment using reviewed examples of correct, partial, incorrect, and hinted answers.
- Check that insufficient evidence, reference conflicts, and unsupported content produce provisional feedback rather than established knowledge gaps or unwarranted demonstrated-understanding judgments.
- Check that untested topics remain not assessed and that hinted answers are distinguished from independent answers.
- Establish measurable acceptance criteria from the reviewed examples. Assessment quality remains unvalidated until those checks pass.
- Measure extraction and assessment resource use to propose first-version upload/page limits and sufficient-evidence criteria.
- Keep the prototype separate from the production implementation. Carry its findings into a spec and dependency-linked GitHub tickets after validation.

## Domain context

Use the terms in [GLOSSARY.md](../GLOSSARY.md). Existing conversation, recording, and desktop data ownership decisions continue to apply; see [ADR 0001](adr/0001-multi-client-conversations-and-single-recorder.md) and [ADR 0002](adr/0002-desktop-backend-and-data-ownership.md).


## Implementation validation and limits

- Test seams confirmed by the learner: study HTTP endpoints, rendered Study UI with reviewed voice drafts, and Ollama extraction/assessment request-response behavior.
- Final review baseline: `6bf5642`.
- Prototype primary source: branch `prototype/study-validation`, commit `55e8f0a39c5ca2c9ac2eeea5defcabb8bb193e96`. It contains the runnable experiment, synthetic printed syllabus image/PDF, raw model responses, and effective outcomes.
- Initial model-only labels failed. A revised prompt plus deterministic source and hint gates passed six curated classification cases and one printed-image extraction fixture. This is narrow smoke evidence; arbitrary grading accuracy remains uncertain. Unsupported feedback stays provisional.
- Initial conservative upload limits: 8 MB per file, up to five selected PDF pages, 50,000 reviewed text characters, twenty files/64 MB per subject; raster inputs are bounded and resized to a 1,600-pixel edge. Larger workloads are not validated.
- Demonstrated understanding requires at least two independent, supported answers at the current topic revision. Hinted answers and guidance requests do not establish progress.
