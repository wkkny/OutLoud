import sqlite3
import threading
from pathlib import Path


class TranscriptInbox:
    """Durable results and acknowledgement markers; replay reads bounded batches.

    No path selects an isolated in-memory database for injected/test runtimes.
    The production server supplies recordings/delivery.sqlite3.
    """

    def __init__(self, path=None):
        if path is not None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.database = sqlite3.connect(str(path) if path is not None else ":memory:", check_same_thread=False)
        self.database.execute("PRAGMA cache_size = -512")
        self.database.execute("""
            CREATE TABLE IF NOT EXISTS results (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT UNIQUE NOT NULL,
                conversation_id TEXT,
                text TEXT,
                acknowledged INTEGER NOT NULL DEFAULT 0
            )
        """)
        self.database.execute("CREATE INDEX IF NOT EXISTS pending_conversation ON results(acknowledged, conversation_id, sequence)")
        self.database.commit()

    def remember(self, event):
        with self.lock, self.database:
            cursor = self.database.execute(
                "INSERT OR IGNORE INTO results(recording_id, conversation_id, text) VALUES (?, ?, ?)",
                (event["recording_id"], event["conversation_id"], event["text"]),
            )
            return cursor.rowcount == 1

    def replay(self, conversation_id=None):
        # A high-water mark keeps new completions on the live path, rather than
        # letting a continuously growing backlog prevent replay from finishing.
        with self.lock:
            through = self.database.execute("SELECT COALESCE(MAX(sequence), 0) FROM results").fetchone()[0]
        after = 0
        while True:
            with self.lock:
                rows = self.database.execute(
                    "SELECT sequence, recording_id, conversation_id, text FROM results "
                    "WHERE acknowledged = 0 AND sequence > ? AND sequence <= ? "
                    "AND (? IS NULL OR conversation_id = ?) ORDER BY sequence LIMIT 16",
                    (after, through, conversation_id, conversation_id),
                ).fetchall()
            if not rows:
                return
            after = rows[-1][0]
            for _, recording_id, conversation, text in rows:
                yield {"type": "transcription.completed", "recording_id": recording_id,
                       "conversation_id": conversation, "text": text}

    def is_pending(self, recording_id):
        with self.lock:
            return self.database.execute(
                "SELECT 1 FROM results WHERE recording_id = ? AND acknowledged = 0", (recording_id,),
            ).fetchone() is not None

    def acknowledge(self, recording_id, conversation_id):
        with self.lock, self.database:
            row = self.database.execute(
                "SELECT conversation_id FROM results WHERE recording_id = ?", (recording_id,),
            ).fetchone()
            if row is None:
                # Unknown acknowledgements never tombstone future completions.
                return True
            if row[0] != conversation_id:
                return False
            self.database.execute(
                "UPDATE results SET acknowledged = 1, text = NULL WHERE recording_id = ?", (recording_id,),
            )
            return True

    def delete_conversation(self, conversation_id):
        with self.lock, self.database:
            self.database.execute("DELETE FROM results WHERE conversation_id=?", (conversation_id,))

    def close(self):
        with self.lock:
            self.database.close()
