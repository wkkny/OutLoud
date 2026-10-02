import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from outloud.delivery import TranscriptInbox


def result(recording_id="one", conversation_id="chat", text="Hello"):
    return {"type": "transcription.completed", "recording_id": recording_id,
            "conversation_id": conversation_id, "text": text, "session_id": "secret"}


class TranscriptInboxTests(unittest.TestCase):
    def test_replay_and_acknowledgements_survive_reopening_without_credentials(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "delivery.sqlite3"
            inbox = TranscriptInbox(path)
            inbox.remember(result("one", "a"))
            inbox.remember(result("two", "b"))
            inbox.acknowledge("one", "a")
            inbox.close()
            reopened = TranscriptInbox(path)
            try:
                self.assertEqual(list(reopened.replay()), [{
                    "type": "transcription.completed", "recording_id": "two",
                    "conversation_id": "b", "text": "Hello",
                }])
                self.assertFalse(reopened.remember(result("one", "a")))
                self.assertFalse(reopened.acknowledge("one", "wrong"))
                self.assertTrue(reopened.acknowledge("one", "a"))
            finally:
                reopened.close()

    def test_replay_finishes_at_its_starting_backlog_and_new_results_remain_replayable(self):
        inbox = TranscriptInbox()
        self.addCleanup(inbox.close)
        for index in range(40):
            inbox.remember(result(str(index), "a"))
        replay = inbox.replay("a")
        self.assertEqual(next(replay)["recording_id"], "0")
        inbox.remember(result("later", "a"))
        remaining = list(replay)
        self.assertEqual([event["recording_id"] for event in remaining], [str(index) for index in range(1, 40)])
        self.assertEqual(list(inbox.replay("a"))[-1]["recording_id"], "later")

    def test_replay_is_scoped_ordered_and_excludes_session_credentials(self):
        inbox = TranscriptInbox()
        inbox.remember(result("one", "a"))
        inbox.remember(result("two", "b"))
        inbox.remember(result("three", "a"))
        replay = list(inbox.replay("a"))
        self.assertEqual([event["recording_id"] for event in replay], ["one", "three"])
        self.assertNotIn("session_id", replay[0])
        replay[0]["text"] = "changed"
        self.assertEqual(list(inbox.replay("a"))[0]["text"], "Hello")

    def test_acknowledgement_is_scoped_idempotent_and_does_not_revive_duplicates(self):
        inbox = TranscriptInbox()
        inbox.remember(result())
        self.assertFalse(inbox.acknowledge("one", "wrong"))
        self.assertEqual(len(list(inbox.replay("chat"))), 1)
        self.assertTrue(inbox.acknowledge("one", "chat"))
        self.assertTrue(inbox.acknowledge("one", "chat"))
        inbox.remember(result())
        self.assertEqual(list(inbox.replay()), [])

    def test_acknowledging_an_unknown_id_cannot_cancel_a_future_result(self):
        inbox = TranscriptInbox()
        self.assertTrue(inbox.acknowledge("one", "chat"))
        inbox.remember(result())
        self.assertEqual(len(list(inbox.replay())), 1)


if __name__ == "__main__":
    unittest.main()
