# OutLoud

OutLoud is a local, voice-first chat application that records speech, transcribes it, and sends reviewed text to a local language model.

## Conversations and recording

**Conversation**:
A saved, independent history of user and assistant messages, with a draft that can be resumed.
_Avoid_: Session (when referring to chat history)

**Recording**:
One microphone capture whose transcript is delivered to the conversation that started it.
_Avoid_: Dictation session (when referring to the captured audio)

**Browser client**:
One open browser tab connected to the local OutLoud backend. Multiple clients may be connected, while microphone recording remains exclusive.
_Avoid_: Owner tab

## Study

**Subject**:
An area the learner is studying, such as DBMS, that groups its topics, study material and related conversations. It supplies shared subject context to those conversations.

**Topic**:
A named part of a subject that the learner intends to study, such as normalization within DBMS.

**Study mode**:
A question-led conversation mode in which answers can supply assessment evidence for a subject's topics.

**Chat mode**:
An open-ended conversation mode for discussion without automatic topic assessment.

**Syllabus**:
The learner-supplied list of topics that defines the scope of study for a subject.

**Reference material**:
Learner-supplied study content used as a basis for evaluating answers. It is distinct from the syllabus that defines study coverage.

**Assessment evidence**:
A learner's answer and any hints received that support a judgment about their understanding of a topic.

**Knowledge gap**:
Missing or incorrect understanding indicated by assessment evidence. A topic that has not been assessed has unknown understanding, rather than an established knowledge gap.

**Exam importance**:
The expected weight of a topic in the learner's exam, based on information supplied by the learner. It remains unknown when that information is unavailable.

**Revision priority**:
The order in which topics are recommended for revision, considering knowledge gaps and available exam importance.

**Topic assessment**:
A dated judgment of a learner's demonstrated understanding of a topic, supported by assessment evidence. Its outcome is demonstrated understanding, partial understanding, needs revision, or not assessed.

**Study progress**:
A subject's accumulated topic assessments and revision priorities, retained across conversations.
