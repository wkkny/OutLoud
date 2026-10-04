# Study mode

Open **Study** in the sidebar, then create a subject such as DBMS. Add topics one per line, or create an empty subject and import its syllabus. Choose an exam type (written, multiple choice, applied problems, mixed, or Not sure). Course/level, exam date, and topic weights are optional and editable.

## Syllabus and references

A syllabus defines which topics to cover. Reference material supplies the basis for evaluating answers. Import printed PDFs or clear PNG/JPEG/WebP photos/scans, choose the file's role, and select PDF pages if needed. Review and correct the extracted text before approval. For syllabus files, enter the reviewed topic names separately; they are added without removing existing topics. References can apply to selected topics or all topics. You can also paste reviewed reference text directly.

Download the original from its review panel to compare it with extraction. Pending imports are not used for assessment. Handwriting is deferred. Limits are 8 MB per file, five selected PDF pages, 50,000 extracted text characters, and twenty files/64 MB per subject. Empty page selection uses the first five PDF pages. Large or unreadable files produce an error instead of silently approving an extraction.

## Study and revision

Choose **Study topic** or **Study next recommendation**. Explain the topic in your own words. Typed and dictated answers enter the existing composer; review your text and press Send. Study answers are limited to 3,000 characters to leave room for references and evidence in the local model's context.

The tutor gives feedback and one follow-up question. **Explain this** provides help, **Practice this** requests a fresh application question, **Move on** returns to the Study area, and **Finish studying** saves a summary. These controls preserve unrelated composer edits. SQL answers are evaluated as text; queries are not executed.

Progress is saved per subject across conversations. Topic judgments are demonstrated understanding, partial understanding, needs revision, or not assessed. Demonstrated understanding requires multiple supported independent answers. Answers immediately after help do not establish progress. Missing references, uncertain evaluation, and unsupported source citations produce provisional guidance rather than established knowledge gaps. Topic cards show evidence and assessment dates, while coverage and demonstrated understanding are counted separately. Exam importance is unknown until you supply a weight; recommendations consider gaps and supplied weights.

The existing Gemma model sometimes misclassifies answers or writes unsuitable questions. Source/hint gates and an identifier check reduce specific observed failures, but do not guarantee grading accuracy. Review feedback against the cited material; this version has only small DBMS smoke validation.

## Recovery and edits

The reviewed answer is saved before waiting for study feedback. Failed or cancelled feedback does not update progress; incomplete structured output is not shown as a finished assessment. Reopening resumes the saved question. **Retry feedback** explicitly starts another feedback attempt; accepted requests are never automatically regenerated on reload.

Renaming a topic preserves progress. Changing its coverage or approved references requires reassessment. Removing a topic from the active syllabus preserves historical assessments. Deleting a conversation removes its answer evidence and recalculates or invalidates dependent assessments. Removing a reference invalidates judgments relying on it. Subject deletion requires confirmation and removes its study conversations, progress, and uploads. Audio files retained by the existing recording system follow its existing retention behavior.

Browser and Electron share this UI. Each backend keeps study records and uploads in its conversation SQLite database, so desktop/browser data separation remains unchanged. Ollama is still local and independently managed. Ordinary chat and recording remain available.

## Validation

The design and confirmed test seams are in [study-mode-design.md](study-mode-design.md). Automated study checks run with the normal `bun run check` command. The small real-model prototype is preserved on `prototype/study-validation` (`55e8f0a`), with raw outputs and a printed syllabus fixture.

Assessment uses a bounded reference context: up to 2,000 characters per applicable reference and 4,000 total. When approved material exceeds that context, feedback stays provisional because omitted text could contain a conflict. Review concise excerpts and map them to their topics before established assessment.
