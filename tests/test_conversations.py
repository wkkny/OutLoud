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

    def test_generated_title_uses_first_message_and_never_overwrites_a_manual_name(self):
        conversation = self.store.create('Biology · Cells', allow_generated_title=True)
        self.store.append_message(conversation['id'], 'user', 'Explain cell membranes')
        self.store.append_message(conversation['id'], 'user', 'Explain mitochondria')
        self.assertEqual(self.store.title_seed(conversation['id']), 'Explain cell membranes')
        self.assertTrue(self.store.set_generated_title(conversation['id'], 'Cell Membrane Basics'))
        self.assertFalse(self.store.set_generated_title(conversation['id'], 'Mitochondria Overview'))
        self.store.update(conversation['id'], title='New chat')
        self.assertIsNone(self.store.title_seed(conversation['id']))
        self.assertFalse(self.store.set_generated_title(conversation['id'], 'Another Model Title'))

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

    def test_workspace_and_turn_context_survive_reopen(self):
        conversation = self.store.create("Study notes", subject_id="subject-1", mode="study", topic_ids=["topic-1", "topic-2"], focus_topic_id="topic-2")
        self.store.start_turn(conversation["id"], "turn", "Explain the difference", request_id="request", turn_context={"mode": "study", "topic_ids": ["topic-1", "topic-2"], "focus_topic_id": "topic-2", "question": "Compare these cases"})
        self.reopen()
        saved = self.store.get(conversation["id"])
        self.assertEqual(saved["subject_id"], "subject-1")
        self.assertEqual(saved["mode"], "study")
        self.assertEqual(saved["topic_ids"], ["topic-1", "topic-2"])
        self.assertEqual(saved["focus_topic_id"], "topic-2")
        self.assertEqual(saved["messages"][0]["turn_context"], {"mode": "study", "topic_ids": ["topic-1", "topic-2"], "focus_topic_id": "topic-2", "question": "Compare these cases"})

    def test_old_conversation_schema_migrates_to_unassigned_chat(self):
        self.store.close()
        self.path.unlink()
        import sqlite3
        database = sqlite3.connect(self.path)
        database.execute("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        database.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('legacy','Legacy','2025-01-01','2025-01-01')")
        database.commit()
        database.close()
        self.store = ConversationStore(self.path)
        self.assertEqual(self.store.get("legacy")["subject_id"], None)
        self.assertEqual(self.store.get("legacy")["mode"], "chat")
        self.assertEqual(self.store.get("legacy")["topic_ids"], [])
