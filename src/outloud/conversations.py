"""Local, durable conversation library and message history."""

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def _now():
    return datetime.now(timezone.utc).isoformat()


class DraftConflict(RuntimeError):
    pass


class ConversationStore:
    def __init__(self, path=None):
        if path is not None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.on_delete = None
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path) if path is not None else ":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deleted_conversations (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS applied_transcripts (
                recording_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'complete', metrics TEXT, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created_at, id);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(conversations)")}
        if "draft_version" not in columns:
            self.db.execute("ALTER TABLE conversations ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0")
        message_columns = {row[1] for row in self.db.execute("PRAGMA table_info(messages)")}
        if "request_id" not in message_columns:
            self.db.execute("ALTER TABLE messages ADD COLUMN request_id TEXT")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS messages_by_request ON messages(conversation_id, request_id, role) WHERE request_id IS NOT NULL")
        # No model task survives a backend restart. Retain interrupted turns for
        # recovery, but never include them in subsequent model context.
        self.db.execute("UPDATE messages SET status='failed' WHERE status='streaming'")
        self.db.commit()

    def list(self):
        with self.lock:
            rows = self.db.execute("SELECT id, title, draft, draft_version, created_at, updated_at FROM conversations ORDER BY updated_at DESC, id").fetchall()
            return [dict(row) for row in rows]

    def get(self, conversation_id):
        with self.lock:
            row = self.db.execute("SELECT id, title, draft, draft_version, created_at, updated_at FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            if row is None:
                return None
            result = dict(row)
            result["messages"] = [dict(message) for message in self.db.execute(
                "SELECT id, role, content, status, metrics, created_at, request_id FROM messages WHERE conversation_id=? ORDER BY rowid",
                (conversation_id,),
            )]
            for message in result["messages"]:
                if message["metrics"] is not None:
                    message["metrics"] = json.loads(message["metrics"])
            return result

    def create(self, title="New chat"):
        conversation_id = str(uuid.uuid4())
        now = _now()
        with self.lock, self.db:
            self.db.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)", (conversation_id, title, now, now))
        return self.get(conversation_id)

    def update(self, conversation_id, *, title=None, draft=None, draft_version=None):
        updates, values = [], []
        if title is not None:
            updates.append("title=?")
            values.append(title)
        if draft is not None:
            updates.extend(["draft=?", "draft_version=draft_version+1"])
            values.append(draft)
        if not updates:
            return self.get(conversation_id)
        updates.append("updated_at=?")
        values.extend([_now(), conversation_id])
        where = "id=?"
        if draft is not None and draft_version is not None:
            where += " AND draft_version=?"
            values.append(draft_version)
        with self.lock, self.db:
            cursor = self.db.execute(f"UPDATE conversations SET {', '.join(updates)} WHERE {where}", values)
            if cursor.rowcount == 0:
                if self.get(conversation_id) is not None:
                    raise DraftConflict("This draft changed in another tab. Reload it before saving.")
                return None
            return self.get(conversation_id)

    def apply_transcript(self, recording_id, conversation_id, text):
        """Atomically return (delivery_allowed, draft_changed) after an append."""
        # Result marker and draft append share one transaction. Live delivery,
        # reconnect replay, and a crash between this commit and acknowledgement
        # can never append the same recording twice.
        with self.lock, self.db:
            row = self.db.execute("SELECT draft FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            if row is None:
                # Legacy clients may use IDs outside the saved library. Only a
                # tombstone refuses delivery; this check cannot follow a commit.
                return not self.was_deleted(conversation_id), False
            added = self.db.execute("INSERT OR IGNORE INTO applied_transcripts(recording_id,conversation_id) VALUES(?,?)", (recording_id, conversation_id))
            if added.rowcount:
                draft = "\n".join(part for part in (row[0], text.strip()) if part)
                self.db.execute("UPDATE conversations SET draft=?, draft_version=draft_version+1, updated_at=? WHERE id=?", (draft, _now(), conversation_id))
            return True, added.rowcount > 0

    def delete(self, conversation_id):
        with self.lock, self.db:
            if self.on_delete is not None:
                self.on_delete(conversation_id)
            cursor = self.db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
            if cursor.rowcount:
                self.db.execute("INSERT OR IGNORE INTO deleted_conversations(id) VALUES(?)", (conversation_id,))
            return cursor.rowcount > 0

    def was_deleted(self, conversation_id):
        with self.lock:
            return self.db.execute("SELECT 1 FROM deleted_conversations WHERE id=?", (conversation_id,)).fetchone() is not None

    def append_message(self, conversation_id, role, content, *, status="complete", metrics=None, message_id=None):
        now = _now()
        message_id = message_id or str(uuid.uuid4())
        with self.lock, self.db:
            exists = self.db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            if exists is None:
                return None
            self.db.execute("INSERT INTO messages(id,conversation_id,role,content,status,metrics,created_at) VALUES(?,?,?,?,?,?,?)",
                            (message_id, conversation_id, role, content, status, json.dumps(metrics) if metrics is not None else None, now))
            self.db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return {"id": message_id, "conversation_id": conversation_id, "role": role, "content": content, "status": status, "metrics": metrics, "created_at": now}

    def context(self, conversation_id):
        with self.lock:
            if self.db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone() is None:
                raise LookupError("Conversation not found")
            rows = self.db.execute(
                "SELECT role, content FROM messages WHERE conversation_id=? AND status='complete' ORDER BY rowid DESC LIMIT 64",
                (conversation_id,),
            ).fetchall()
            return [dict(row) for row in reversed(rows)]

    def request_messages(self, conversation_id, request_id):
        with self.lock:
            detail = self.get(conversation_id)
            return [message for message in detail["messages"] if message["request_id"] == request_id] if detail else []

    def start_turn(self, conversation_id, turn_id, content, request_id=None, on_start=None):
        with self.lock, self.db:
            if self.db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone() is None:
                raise LookupError("Conversation not found")
            if request_id is not None and self.request_messages(conversation_id, request_id):
                return False
            for role, text in (("user", content), ("assistant", "")):
                self.db.execute(
                    "INSERT INTO messages(id,conversation_id,role,content,status,created_at,request_id) VALUES(?,?,?,?,?,?,?)",
                    (f"{turn_id}-{role}", conversation_id, role, text, "streaming", _now(), request_id),
                )
            if on_start is not None:
                on_start()
            self.db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (_now(), conversation_id))
            return True

    def finish_turn(self, conversation_id, turn_id, content, status, metrics=None, on_complete=None):
        with self.lock, self.db:
            self.db.execute("UPDATE messages SET status=? WHERE id=?", (status, f"{turn_id}-user"))
            self.db.execute(
                "UPDATE messages SET content=?, status=?, metrics=? WHERE id=?",
                (content, status, json.dumps(metrics) if metrics is not None else None, f"{turn_id}-assistant"),
            )
            if status == 'complete' and on_complete is not None:
                on_complete(f'{turn_id}-user')
            # If the conversation was deleted mid-generation, updates are no-ops;
            # an in-flight reply must never resurrect deleted content.
            self.db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (_now(), conversation_id))

    def close(self):
        with self.lock:
            self.db.close()
