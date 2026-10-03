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
