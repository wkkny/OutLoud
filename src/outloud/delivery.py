import threading


class TranscriptInbox:
    """Unacknowledged results for this backend lifetime, keyed by recording ID."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}
        self.acknowledged = {}

    def remember(self, event):
        with self.lock:
            recording_id = event["recording_id"]
            if recording_id in self.acknowledged or recording_id in self.pending:
                return False
            self.pending[recording_id] = {
                "type": "transcription.completed",
                "recording_id": recording_id,
                "conversation_id": event["conversation_id"],
                "text": event["text"],
            }
            return True

    def replay(self, conversation_id=None):
        with self.lock:
            return [dict(event) for event in self.pending.values()
                    if conversation_id is None or event["conversation_id"] == conversation_id]

    def acknowledge(self, recording_id, conversation_id):
        with self.lock:
            event = self.pending.get(recording_id)
            if event is not None:
                if event["conversation_id"] != conversation_id:
                    return False
                self.acknowledged[recording_id] = conversation_id
                del self.pending[recording_id]
                return True
            # An unknown ID is harmless (e.g. the backend restarted), but must
            # never tombstone a result that hasn't completed yet.
            return recording_id not in self.acknowledged or self.acknowledged[recording_id] == conversation_id
