import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from outloud.conversations import ConversationStore


class ConversationStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "conversations.sqlite3"
        self.store = ConversationStore(self.path)
        self.addCleanup(lambda: self.store.close())

    def reopen(self):
        self.store.close()
        self.store = ConversationStore(self.path)

    def test_conversations_and_drafts_survive_reopen(self):
        first = self.store.create("Planning")
        second = self.store.create("Research")
        self.store.update(first["id"], draft="unsent thought")
        self.store.append_message(first["id"], "user", "hello")
        self.store.append_message(first["id"], "assistant", "hi")
        self.reopen()
        library = self.store.list()
        self.assertEqual({item["id"] for item in library}, {first["id"], second["id"]})
        resumed = self.store.get(first["id"])
        self.assertEqual(resumed["draft"], "unsent thought")
        self.assertEqual([(item["role"], item["content"]) for item in resumed["messages"]], [("user", "hello"), ("assistant", "hi")])

    def test_delete_removes_conversation_and_messages(self):
        conversation = self.store.create()
        self.store.append_message(conversation["id"], "user", "private")
        self.assertTrue(self.store.delete(conversation["id"]))
        self.assertIsNone(self.store.get(conversation["id"]))
        self.assertFalse(self.store.delete(conversation["id"]))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)

    def test_restart_marks_inflight_turn_failed_and_excludes_it_from_context(self):
        conversation = self.store.create()
        self.store.start_turn(conversation["id"], "interrupted", "Keep my text")
        self.reopen()
        messages = self.store.get(conversation["id"])["messages"]
        self.assertEqual([message["status"] for message in messages], ["failed", "failed"])
        self.assertEqual(messages[0]["content"], "Keep my text")
        self.assertEqual(self.store.context(conversation["id"]), [])

    def test_finishing_a_deleted_conversation_never_resurrects_content(self):
        conversation = self.store.create()
        self.store.start_turn(conversation["id"], "turn", "Hello")
        self.store.delete(conversation["id"])
        self.store.finish_turn(conversation["id"], "turn", "Hi", "complete")
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)

    def test_turn_status_and_metrics_are_saved_atomically(self):
        conversation = self.store.create()
        self.store.start_turn(conversation["id"], "turn", "Hello")
        self.store.finish_turn(conversation["id"], "turn", "Hi", "complete", {"elapsed_seconds": 1})
        self.reopen()
        messages = self.store.get(conversation["id"])["messages"]
        self.assertEqual([message["status"] for message in messages], ["complete", "complete"])
        self.assertEqual(messages[1]["metrics"], {"elapsed_seconds": 1})
