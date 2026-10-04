import asyncio
import sqlite3
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from outloud.runtime import RecordingRuntime
from outloud.server import ConversationCreate, ConversationUpdate, create_app
from test_server import FakeRecorder


class ConversationWriteCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.app = create_app(lambda publish: RecordingRuntime(publish, FakeRecorder(Path(self.directory.name))), conversations_path=Path(self.directory.name) / "conversations.sqlite3")
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.endpoints = {route.name: route.endpoint for route in self.app.routes if hasattr(route, "endpoint")}
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        await self.incoming.put({"type": "websocket.connect"})
        scope = {"type": "websocket", "scheme": "ws", "path": "/events", "raw_path": b"/events", "query_string": b"", "headers": [(b"host", b"127.0.0.1"), (b"origin", b"http://localhost:5173")], "server": ("127.0.0.1", 8765), "client": ("127.0.0.1", 1234), "subprotocols": []}
        self.socket = asyncio.create_task(self.app(scope, self.incoming.get, self.outgoing.put))
        await self.event("session.ready")

    async def asyncTearDown(self):
        await self.incoming.put({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(self.socket, 3)
        await self.lifespan.__aexit__(None, None, None)
        self.directory.cleanup()

    async def event(self, kind):
        import json
        async with asyncio.timeout(3):
            while True:
                event = await self.outgoing.get()
                if event["type"] == "websocket.send":
                    decoded = json.loads(event["text"])
                    if decoded["type"] == kind:
                        return decoded

    async def cancel_during_write(self, method, operation):
        entered, release = threading.Event(), threading.Event()
        original = getattr(self.app.state.conversations, method)

        def blocked(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError("Write was not released")
            return original(*args, **kwargs)

        with patch.object(self.app.state.conversations, method, blocked):
            task = asyncio.create_task(operation())
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                task.cancel()
                await asyncio.sleep(0)
                self.assertFalse(task.done(), "The accepted write must finish before cancellation propagates")
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)

    async def test_transcript_commit_cannot_lose_its_notification_to_a_later_storage_read(self):
        conversation = self.app.state.conversations.create()["id"]
        with patch.object(self.app.state.conversations, "was_deleted", side_effect=sqlite3.OperationalError("post-commit read failed")):
            self.app.state.runtime.publish({"type": "transcription.completed", "recording_id": "committed", "conversation_id": conversation, "text": "Committed words"})
            self.assertEqual((await self.event("conversation.updated"))["conversation_id"], conversation)
            self.assertEqual((await self.event("transcription.completed"))["text"], "Committed words")
        self.assertEqual(self.app.state.conversations.get(conversation)["draft"], "Committed words")

    async def test_cancelled_create_still_notifies_the_shared_library(self):
        await self.cancel_during_write("create", lambda: self.endpoints["create_conversation"](ConversationCreate(title="Saved despite cancellation")))
        saved = self.app.state.conversations.list()
        self.assertEqual(len(saved), 1)
        self.assertEqual((await self.event("conversation.updated"))["conversation_id"], saved[0]["id"])

    async def test_cancelled_patch_still_notifies_the_shared_library(self):
        conversation = self.app.state.conversations.create()["id"]
        await self.cancel_during_write("update", lambda: self.endpoints["update_conversation"](conversation, ConversationUpdate(draft="Saved draft", draft_version=0)))
        self.assertEqual(self.app.state.conversations.get(conversation)["draft"], "Saved draft")
        self.assertEqual((await self.event("conversation.updated"))["conversation_id"], conversation)

    async def test_cancelled_delete_finishes_generation_and_inbox_cleanup(self):
        conversation = self.app.state.conversations.create()["id"]
        inbox = self.app.state.runtime.transcripts
        inbox.remember({"recording_id": "pending", "conversation_id": conversation, "text": "Private words"})
        with patch.object(self.app.state.chat, "cancel_conversation", wraps=self.app.state.chat.cancel_conversation) as cancel:
            await self.cancel_during_write("delete", lambda: self.endpoints["delete_conversation"](conversation))
            cancel.assert_called_once_with(conversation)
        self.assertIsNone(self.app.state.conversations.get(conversation))
        self.assertEqual(list(inbox.replay(conversation)), [])
        self.assertEqual((await self.event("conversation.updated"))["conversation_id"], conversation)
