import asyncio
import json
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx2

from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.requests = []
        self.title_requests = []

        async def ollama(request):
            payload = json.loads(request.content)
            if not payload['stream']:
                self.title_requests.append(payload)
                return httpx2.Response(200, json={"message": {"content": "Greeting the assistant"}})
            self.requests.append(payload)
            return httpx2.Response(200, content=(
                '{"message":{"content":"Hello "},"done":false}\n'
                '{"message":{"content":"there."},"done":false}\n'
                '{"message":{"content":""},"done":true,"eval_count":2,"total_duration":1000000000}\n'
            ))

        self.handler = ollama
        self.app = create_app(
            lambda publish: RecordingRuntime(publish, FakeRecorder(Path(self.directory.name))),
            ollama_client_factory=lambda: httpx2.AsyncClient(
                base_url="http://127.0.0.1:11434", transport=httpx2.MockTransport(lambda request: self.handler(request)),
            ),
        )
        self.client = LocalTestClient(self.app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.conversation_id = self.client.post("/conversations", json={}).json()["id"]
        self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def headers(self, socket):
        return {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}

    def body(self, request_id="request-one"):
        return {"request_id": request_id, "conversation_id": self.conversation_id, "messages": [{"role": "user", "content": "Hello"}]}

    def wait_for_title(self, expected):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            title = self.client.get(f"/conversations/{self.conversation_id}").json()["title"]
            if title == expected:
                return
            time.sleep(0.01)
        self.fail(f"Conversation title did not become {expected!r}; last value was {title!r}")

    def test_owner_can_stream_gemma_reply_with_bounded_context_and_metrics(self):
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            response = self.client.post("/chat", headers=self.headers(socket), json=self.body())
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line) for line in response.text.splitlines()]
            self.assertEqual([event["type"] for event in events], ["chat.started", "chat.delta", "chat.delta", "chat.done"])
            self.assertEqual("".join(event["text"] for event in events if event["type"] == "chat.delta"), "Hello there.")
            self.assertEqual(events[-1]["metrics"]["output_tokens"], 2)
            self.assertEqual(self.requests[0]["model"], "gemma3:4b")
            self.assertEqual(self.requests[0]["options"], {"num_ctx": 4096, "num_predict": 1024})
            self.wait_for_title("Greeting the assistant")
            self.assertEqual(self.title_requests[0]["messages"][-1]["content"], "Hello")
            self.assertTrue(self.client.get("/ready").json()["ready"])

    def test_generated_title_only_uses_first_message_and_preserves_manual_rename(self):
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            self.assertEqual(self.client.post("/chat", headers=headers, json=self.body()).status_code, 200)
            self.wait_for_title("Greeting the assistant")
            second = {**self.body('request-two'), 'messages': [{'role': 'user', 'content': 'A different topic'}]}
            self.assertEqual(self.client.post("/chat", headers=headers, json=second).status_code, 200)
            self.assertEqual(len(self.title_requests), 1)
            self.client.patch(f"/conversations/{self.conversation_id}", json={'title': 'New chat'})
            self.assertEqual(self.client.post("/chat", headers=headers, json={**self.body('request-three'), 'messages': [{'role': 'user', 'content': 'Another topic'}]}).status_code, 200)
            self.assertEqual(len(self.title_requests), 1)
            self.assertEqual(self.client.get(f"/conversations/{self.conversation_id}").json()["title"], 'New chat')

    def test_manual_rename_during_title_generation_wins(self):
        async def rename_during_title(request):
            payload = json.loads(request.content)
            if not payload['stream']:
                self.app.state.conversations.update(self.conversation_id, title='My own name')
                return httpx2.Response(200, json={"message": {"content": "Model name"}})
            return httpx2.Response(200, content='{"message":{"content":"Reply"},"done":true}\n')
        self.handler = rename_during_title
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            events = [json.loads(line) for line in self.client.post("/chat", headers=self.headers(socket), json=self.body()).text.splitlines()]
            self.assertEqual(events[-1]['type'], 'chat.done')
            self.wait_for_title('My own name')

    def test_slow_title_does_not_delay_completed_reply(self):
        title_started = threading.Event()
        release_title = threading.Event()
        reply_finished = threading.Event()
        responses = []

        async def slow_title(request):
            if not json.loads(request.content)['stream']:
                title_started.set()
                await asyncio.to_thread(release_title.wait, 2)
                return httpx2.Response(200, json={"message": {"content": "Delayed title"}})
            return httpx2.Response(200, content='{"message":{"content":"Reply"},"done":true}\n')

        self.handler = slow_title
        self.app.state.chat.max_concurrent = 1
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)

            def request_reply():
                responses.append(self.client.post("/chat", headers=headers, json=self.body()))
                reply_finished.set()

            worker = threading.Thread(target=request_reply)
            worker.start()
            try:
                self.assertTrue(title_started.wait(2))
                self.assertTrue(reply_finished.wait(0.5), "Chat response waited for title generation")
                next_reply = self.client.post("/chat", headers=headers, json=self.body("request-two"))
                self.assertEqual(next_reply.status_code, 429)
            finally:
                release_title.set()
                worker.join(2)
            self.assertEqual([json.loads(line)['type'] for line in responses[0].text.splitlines()][-1], 'chat.done')
            self.wait_for_title('Delayed title')

    def test_title_failure_does_not_fail_reply(self):
        async def title_unavailable(request):
            if not json.loads(request.content)['stream']:
                return httpx2.Response(503)
            return httpx2.Response(200, content='{"message":{"content":"Reply"},"done":true}\n')
        self.handler = title_unavailable
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            events = [json.loads(line) for line in self.client.post("/chat", headers=self.headers(socket), json=self.body()).text.splitlines()]
            self.assertEqual(events[-1]['type'], 'chat.done')
            self.assertEqual(self.client.get(f"/conversations/{self.conversation_id}").json()["title"], 'New chat')

    def test_ollama_failure_is_safe_and_does_not_disable_dictation(self):
        async def unavailable(request):
            raise httpx2.ConnectError("secret diagnostics", request=request)
        self.handler = unavailable
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            events = [json.loads(line) for line in self.client.post("/chat", headers=headers, json=self.body()).text.splitlines()]
            self.assertEqual(events[0]["type"], "chat.error")
            self.assertIn("ollama serve", events[0]["message"])
            self.assertNotIn("secret", events[0]["message"])
            self.assertTrue(self.client.get("/state").json()["ready"])
            self.assertTrue(self.client.get("/state").json()["ui_connected"])

    def test_missing_model_and_invalid_stream_have_clear_terminal_errors(self):
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            for status, content, expected in (
                (404, '', 'ollama pull gemma3:4b'),
                (200, 'not json\n', 'invalid'),
                (200, '{"message":{"content":"Partial"},"done":false}\n', 'complete reply'),
            ):
                async def reply(request):
                    return httpx2.Response(status, content=content)
                self.handler = reply
                response = self.client.post("/chat", headers=headers, json=self.body())
                terminal = json.loads(response.text.splitlines()[-1])
                self.assertEqual(terminal["type"], "chat.error")
                self.assertIn(expected, terminal["message"])

    def test_empty_or_whitespace_only_reply_never_accepts_the_draft(self):
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            for text in ("", " \n\t"):
                async def empty(request):
                    return httpx2.Response(200, content=json.dumps({"message": {"content": text}, "done": True}) + "\n")
                self.handler = empty
                response = self.client.post("/chat", headers=headers, json=self.body())
                events = [json.loads(line) for line in response.text.splitlines()]
                self.assertEqual([event["type"] for event in events], ["chat.error"])
                self.assertIn("empty reply", events[0]["message"])

    def test_empty_header_chunks_wait_for_content_and_preserve_leading_whitespace(self):
        async def leading(request):
            packets = [
                {"message": {"content": ""}, "done": False},
                {"message": {"content": " \n"}, "done": False},
                {"message": {"content": "Hello"}, "done": True},
            ]
            return httpx2.Response(200, content="".join(json.dumps(packet) + "\n" for packet in packets))
        self.handler = leading
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            response = self.client.post("/chat", headers=self.headers(socket), json=self.body())
            events = [json.loads(line) for line in response.text.splitlines()]
            self.assertEqual([event["type"] for event in events], ["chat.started", "chat.delta", "chat.done"])
            self.assertEqual(events[1]["text"], " \nHello")

    def test_large_history_trims_old_pairs_but_keeps_latest_user_text(self):
        self.app.state.conversations.append_message(self.conversation_id, "user", "x" * 7000)
        self.app.state.conversations.append_message(self.conversation_id, "assistant", "Earlier reply" * 1100)
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            body = {**self.body(), "messages": [
                {"role": "user", "content": "x" * 7000},
                {"role": "assistant", "content": "Earlier reply" * 1100},
                {"role": "user", "content": "y" * 6000},
            ]}
            self.assertEqual(self.client.post("/chat", headers=self.headers(socket), json=body).status_code, 200)
            self.assertEqual(self.requests[-1]["messages"], [{"role": "user", "content": "y" * 6000}])

    def test_requires_owner_and_matching_conversation_and_valid_turns(self):
        self.assertEqual(self.client.post("/chat", json=self.body()).status_code, 403)
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            wrong = {**self.body(), "conversation_id": "other"}
            self.assertEqual(self.client.post("/chat", headers=headers, json=wrong).status_code, 403)
            invalid = {**self.body(), "messages": [{"role": "assistant", "content": "Not a user turn"}]}
            self.assertEqual(self.client.post("/chat", headers=headers, json=invalid).status_code, 422)
            oversized = {**self.body(), "messages": [{"role": "user", "content": "x" * 12001}]}
            self.assertEqual(self.client.post("/chat", headers=headers, json=oversized).status_code, 422)
            self.assertEqual(self.requests, [])

    def test_owner_disconnect_cancels_generation_without_stopping_required_workers(self):
        entered = threading.Event()
        finish = threading.Event()

        class WaitingReply(httpx2.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"message":{"content":"Partial"},"done":false}\n'
                entered.set()
                while not finish.is_set():
                    await asyncio.sleep(0.005)

        async def waiting(request):
            return httpx2.Response(200, stream=WaitingReply())

        self.handler = waiting
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            replies = []
            worker = threading.Thread(target=lambda: replies.append(self.client.post("/chat", headers=headers, json=self.body())))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                socket.close()
                worker.join(3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(json.loads(replies[0].text.splitlines()[-1])["type"], "chat.cancelled")
                self.assertTrue(self.client.get("/ready").json()["ready"])
                self.assertFalse(self.client.get("/state").json()["ui_connected"])
            finally:
                finish.set()
                worker.join(3)

    def test_repeated_cancellation_does_not_interrupt_upstream_cleanup(self):
        entered = threading.Event()
        closing = threading.Event()
        release = threading.Event()
        closed = threading.Event()

        class ClosingReply(httpx2.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"message":{"content":"Partial"},"done":false}\n'
                entered.set()
                while True:
                    await asyncio.sleep(0.005)

            async def aclose(self):
                closing.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
                closed.set()

        async def response(request):
            return httpx2.Response(200, stream=ClosingReply())

        self.handler = response
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            worker = threading.Thread(target=lambda: self.client.post("/chat", headers=headers, json=self.body()))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.client.post("/chat/cancel", headers=headers, json={"request_id": "request-one"})
                self.assertTrue(closing.wait(3))
                self.client.post("/chat/cancel", headers=headers, json={"request_id": "request-one"})
                release.set()
                worker.join(3)
                self.assertFalse(worker.is_alive())
                self.assertTrue(closed.is_set(), "Repeated cancellation interrupted Ollama connection cleanup")
            finally:
                release.set()
                worker.join(3)

    def test_cancel_is_request_scoped_and_allows_another_generation(self):
        entered = threading.Event()
        finish = threading.Event()

        class SlowReply(httpx2.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"message":{"content":"Partial"},"done":false}\n'
                entered.set()
                while not finish.is_set():
                    await asyncio.sleep(0.005)
                yield b'{"message":{"content":""},"done":true}\n'

        async def slow(request):
            return httpx2.Response(200, stream=SlowReply())

        self.handler = slow
        with self.client.websocket_connect(f"/events?conversation_id={self.conversation_id}", headers=ORIGIN) as socket:
            headers = self.headers(socket)
            replies = []
            worker = threading.Thread(target=lambda: replies.append(self.client.post("/chat", headers=headers, json=self.body())))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.client.post("/chat", headers=headers, json=self.body("another")).status_code, 409)
                stale = self.client.post("/chat/cancel", headers=headers, json={"request_id": "stale"})
                self.assertFalse(stale.json()["active"])
                self.assertTrue(self.client.post("/chat/cancel", headers=headers, json={"request_id": "request-one"}).json()["active"])
                worker.join(3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(json.loads(replies[0].text.splitlines()[-1])["type"], "chat.cancelled")
                finish.set()
                self.assertEqual(self.client.post("/chat", headers=headers, json=self.body("next")).status_code, 200)
            finally:
                finish.set()
                worker.join(3)


if __name__ == "__main__":
    unittest.main()
