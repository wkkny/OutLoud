import unittest

from outloud.delivery import TranscriptInbox


def result(recording_id="one", conversation_id="chat", text="Hello"):
    return {"type": "transcription.completed", "recording_id": recording_id,
            "conversation_id": conversation_id, "text": text, "session_id": "secret"}


class TranscriptInboxTests(unittest.TestCase):
    def test_replay_is_scoped_ordered_and_excludes_session_credentials(self):
        inbox = TranscriptInbox()
        inbox.remember(result("one", "a"))
        inbox.remember(result("two", "b"))
        inbox.remember(result("three", "a"))
        replay = inbox.replay("a")
        self.assertEqual([event["recording_id"] for event in replay], ["one", "three"])
        self.assertNotIn("session_id", replay[0])
        replay[0]["text"] = "changed"
        self.assertEqual(inbox.replay("a")[0]["text"], "Hello")

    def test_acknowledgement_is_scoped_idempotent_and_does_not_revive_duplicates(self):
        inbox = TranscriptInbox()
        inbox.remember(result())
        self.assertFalse(inbox.acknowledge("one", "wrong"))
        self.assertEqual(len(inbox.replay("chat")), 1)
        self.assertTrue(inbox.acknowledge("one", "chat"))
        self.assertTrue(inbox.acknowledge("one", "chat"))
        inbox.remember(result())
        self.assertEqual(inbox.replay(), [])

    def test_acknowledging_an_unknown_id_cannot_cancel_a_future_result(self):
        inbox = TranscriptInbox()
        self.assertTrue(inbox.acknowledge("one", "chat"))
        inbox.remember(result())
        self.assertEqual(len(inbox.replay()), 1)


if __name__ == "__main__":
    unittest.main()
