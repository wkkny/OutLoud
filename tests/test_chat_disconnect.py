import asyncio
import json
import threading
import unittest
from unittest.mock import patch

import httpx2
from starlette.responses import StreamingResponse

from outloud.chat import Chat, ChatBusy, ChatRequest
from outloud.conversations import ConversationStore


class ChatDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = ConversationStore()
        self.conversation = self.store.create()["id"]
        self.entered = threading.Event()
        self.release = threading.Event()
        self.drained = threading.Event()
        original = self.store.finish_turn

        def blocked_finish(*args):
            self.entered.set()
            if not self.release.wait(5):
                raise AssertionError("Final write was not released")
            original(*args)
            self.drained.set()

        self.finish_patch = patch.object(self.store, "finish_turn", blocked_finish)
        self.finish_patch.start()

        async def ollama(request):
            return httpx2.Response(200, content='{"message":{"content":"Hello"},"done":true}\n')

        self.chat = Chat(lambda: httpx2.AsyncClient(base_url="http://localhost:11434", transport=httpx2.MockTransport(ollama)), store=self.store)

    async def asyncTearDown(self):
        self.release.set()
        await asyncio.wait_for(self.chat.close(), timeout=3)
        self.finish_patch.stop()
        self.store.close()

    def start(self, request_id="one"):
        return self.chat.start("client", ChatRequest(request_id=request_id, conversation_id=self.conversation, messages=[{"role": "user", "content": "Question"}]))

    async def wait_for_finish(self):
        self.assertTrue(await asyncio.to_thread(self.entered.wait, 3))

    async def test_real_http_disconnect_cannot_release_slot_before_sqlite_drains(self):
        generation = self.start()
        incoming = asyncio.Queue()
        disconnected = asyncio.Event()

        async def receive():
            message = await incoming.get()
            disconnected.set()
            return message

        async def send(message):
            pass

        response = StreamingResponse(self.chat.stream(generation))
        response_task = asyncio.create_task(response({"type": "http", "asgi": {"spec_version": "2.0"}}, receive, send))
        try:
            await self.wait_for_finish()
            await incoming.put({"type": "http.disconnect"})
            await asyncio.wait_for(disconnected.wait(), 1)
            # Flush response-scope cancellation through its cleanup awaits.
            for _ in range(20):
                await asyncio.sleep(0)
            self.assertFalse(self.drained.is_set())
            self.assertFalse(generation.task.done(), "Generation ended before its SQLite thread drained")
            with self.assertRaises(ChatBusy):
                self.start("retry")
            self.release.set()
            await asyncio.wait_for(response_task, 3)
            self.assertTrue(self.drained.is_set())
            self.assertEqual(self.store.context(self.conversation), [{"role": "user", "content": "Question"}, {"role": "assistant", "content": "Hello"}])
        finally:
            self.release.set()
            await asyncio.gather(response_task, return_exceptions=True)

    async def test_stop_after_completion_started_preserves_events_and_reports_inactive(self):
        generation = self.start()
        await self.wait_for_finish()
        self.assertFalse(self.chat.cancel("client", "one"))
        self.release.set()
        events = [json.loads(line) async for line in self.chat.stream(generation)]
        self.assertEqual([event["type"] for event in events], ["chat.started", "chat.delta", "chat.done"])
        self.assertEqual(events[1]["text"], "Hello")
        self.assertEqual(self.store.get(self.conversation)["messages"][1]["content"], "Hello")

    async def test_repeated_task_cancellation_drains_sqlite_before_releasing_slot(self):
        generation = self.start()
        await self.wait_for_finish()
        for _ in range(3):
            generation.task.cancel()
            await asyncio.sleep(0)
        self.assertFalse(generation.task.done())
        with self.assertRaises(ChatBusy):
            self.start("retry")
        self.release.set()
        await asyncio.gather(generation.task, return_exceptions=True)
        self.assertTrue(self.drained.is_set())
