import asyncio
import concurrent.futures
import json
import sqlite3
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx2

from outloud.runtime import RecordingRuntime
from outloud.delivery import TranscriptInbox
from outloud.server import create_app
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type
from test_fn_shortcut import FakeFnFactory


class MultiClientChatTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "conversations.sqlite3"
        self.env = patch.dict("os.environ", {"OUTLOUD_CONVERSATIONS_DB": str(self.path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        model = patch("outloud.transcription.whisper.load_model")
        model.start().return_value.transcribe.return_value = {"text": "Transcript"}
        self.addCleanup(model.stop)
        self.requests = []
        self.handler = self.reply
        self.client = self.open_client()
        self.addCleanup(lambda: self.client.__exit__(None, None, None))

    async def reply(self, request):
        self.requests.append(json.loads(request.content))
        return httpx2.Response(200, content='{"message":{"content":"Hello"},"done":true}\n')

    def open_client(self):
        app = create_app(
            lambda publish: RecordingRuntime(publish, FakeRecorder(Path(self.directory.name)), delivery_path=Path(self.directory.name) / "delivery.sqlite3"),
            ollama_client_factory=lambda: httpx2.AsyncClient(
                base_url="http://127.0.0.1:11434", transport=httpx2.MockTransport(lambda request: self.handler(request)),
            ),
        )
        client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        client.__enter__()
        self.app = app
        return client

    def create(self):
        return self.client.post("/conversations", json={}).json()["id"]

    def connect(self, conversation_id):
        return self.client.websocket_connect(f"/events?conversation_id={conversation_id}", headers=ORIGIN)

    def headers(self, socket):
        return {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}

    def body(self, conversation_id, request_id="request", text="First"):
        return {"conversation_id": conversation_id, "request_id": request_id, "messages": [{"role": "user", "content": text}]}

    def test_retry_of_accepted_request_replays_without_another_saved_turn_or_model_call(self):
        conversation = self.create()
        with self.connect(conversation) as socket:
            headers = self.headers(socket)
            body = self.body(conversation, "retry-same-message")
            first = self.client.post("/chat", headers=headers, json=body)
            self.assertEqual(first.status_code, 200)
            before = self.client.get(f"/conversations/{conversation}").json()["messages"]
            retried = self.client.post("/chat", headers=headers, json=body)
            events = [json.loads(line) for line in retried.text.splitlines()]
            self.assertEqual([event["type"] for event in events], ["chat.started", "chat.delta", "chat.done"])
            self.assertEqual(events[1]["text"], "Hello")
            after = self.client.get(f"/conversations/{conversation}").json()["messages"]
            self.assertEqual(after, before)
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(after[0]["request_id"], "retry-same-message")

        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        with self.connect(conversation) as socket:
            replayed = self.client.post("/chat", headers=self.headers(socket), json=body)
            self.assertEqual(json.loads(replayed.text.splitlines()[-1])["type"], "chat.done")
            self.assertEqual(self.client.get(f"/conversations/{conversation}").json()["messages"], before)
            self.assertEqual(len(self.requests), 1)

    def test_start_endpoint_binds_capture_and_transcript_to_durable_draft(self):
        first, second = self.create(), self.create()
        self.client.patch(f"/conversations/{first}", json={"draft": "Typed text"})
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            self.assertEqual(self.client.post("/recording/start", headers=ha, json={"conversation_id": first}).status_code, 202)
            self.assertEqual(self.client.post("/recording/start", headers=ha, json={"conversation_id": first}).status_code, 409)
            self.assertEqual(self.client.post("/recording/start", headers=hb, json={"conversation_id": second}).status_code, 409)
            self.assertTrue(self.client.get("/state", headers=ha).json()["capture_owned"])
            self.assertFalse(self.client.get("/state", headers=hb).json()["capture_owned"])
            self.client.post("/recording/stop", headers=ha)
            result = receive_type(a, "transcription.completed", max_events=100)
            self.assertEqual(self.client.get(f"/conversations/{first}").json()["draft"], "Typed text\nTranscript")
            self.assertEqual(self.client.get(f"/conversations/{second}").json()["draft"], "")
            # Reconnect replay cannot append the result twice, even after a user
            # clears the draft before acknowledging the replay.
            self.client.patch(f"/conversations/{first}", json={"draft": ""})
        with self.connect(first) as a:
            self.headers(a)
            replay = receive_type(a, "transcription.completed", max_events=100)
            self.assertEqual(replay["recording_id"], result["recording_id"])
            self.assertEqual(self.client.get(f"/conversations/{first}").json()["draft"], "")

    def test_deleted_conversations_discard_late_transcript_replay(self):
        conversation = self.create()
        self.client.delete(f"/conversations/{conversation}")
        with self.connect(conversation) as socket:
            self.headers(socket)
            self.app.state.runtime.publish({"type": "transcription.completed", "recording_id": "late", "conversation_id": conversation, "text": "Deleted private text"})
            # A following library/state event is the barrier after draft processing.
            while True:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "transcription.completed")
                if event["type"] == "conversation.updated":
                    break
            self.assertEqual(self.client.get(f"/conversations/{conversation}").status_code, 404)
        with self.connect(conversation) as socket:
            self.headers(socket)
            socket.send_json({"type": "session.ping", "id": 8})
            while True:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "transcription.completed")
                if event["type"] == "session.pong":
                    break

    def test_startup_recovers_offline_transcripts_once_even_after_draft_clear(self):
        conversation_id = self.create()
        self.client.__exit__(None, None, None)
        inbox = TranscriptInbox(Path(self.directory.name) / "delivery.sqlite3")
        inbox.remember({"type": "transcription.completed", "recording_id": "offline", "conversation_id": conversation_id, "text": "Recovered words"})
        inbox.close()
        self.client = self.open_client()
        url = f"/conversations/{conversation_id}"
        self.assertEqual(self.client.get(url).json()["draft"], "Recovered words")
        self.client.patch(url, json={"draft": ""})
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        with self.connect(conversation_id) as socket:
            self.headers(socket)
            self.assertEqual(receive_type(socket, "transcription.completed")["recording_id"], "offline")
            self.assertEqual(self.client.get(url).json()["draft"], "")

    def test_replay_recovery_notifies_an_already_connected_tab(self):
        conversation = self.create()
        event = {"type": "transcription.completed", "recording_id": "recover-on-replay", "conversation_id": conversation, "text": "Recovered on replay"}
        with self.connect(conversation) as a:
            self.headers(a)
            with patch.object(self.app.state.conversations, "apply_transcript", side_effect=sqlite3.OperationalError("temporarily busy")):
                self.app.state.runtime.publish(event)
                receive_type(a, "transcription.error")
            self.assertEqual(self.client.get(f"/conversations/{conversation}").json()["draft"], "")
            with self.connect(conversation) as b:
                self.headers(b)
                receive_type(b, "transcription.completed")
                self.assertEqual(receive_type(a, "conversation.updated")["conversation_id"], conversation)
                self.assertEqual(self.client.get(f"/conversations/{conversation}").json()["draft"], "Recovered on replay")

    def test_shared_library_notifies_all_clients_after_rename_and_delete(self):
        conversation_id = self.create()
        url = f"/conversations/{conversation_id}"
        with self.connect(conversation_id) as a, self.connect(conversation_id) as b:
            self.headers(a)
            self.headers(b)
            self.client.patch(url, json={"title": "Shared name"})
            self.assertEqual(receive_type(a, "conversation.updated")["conversation_id"], conversation_id)
            self.assertEqual(receive_type(b, "conversation.updated")["conversation_id"], conversation_id)
            self.assertEqual(self.client.get(url).json()["title"], "Shared name")
            self.client.delete(url)
            self.assertEqual(receive_type(a, "conversation.updated")["conversation_id"], conversation_id)
            self.assertEqual(receive_type(b, "conversation.updated")["conversation_id"], conversation_id)
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_recovery_state_distinguishes_old_capture_from_another_clients_recording(self):
        first, second = self.create(), self.create()
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            a.close()
            self.client.post("/recording/start", headers=hb, json={"conversation_id": second})
            receive_type(b, "recording.state")
            state = self.client.get("/state", headers=ha).json()
            self.assertTrue(state["ui_connected"])
            self.assertTrue(state["recording"])
            self.assertFalse(state["client_connected"])
            self.assertFalse(state["capture_owned"])
            self.client.post("/recording/stop", headers=hb)
            receive_type(b, "transcription.completed", max_events=100)

    def test_stale_draft_updates_are_refused_without_overwriting_shared_text(self):
        conversation_id = self.create()
        url = f"/conversations/{conversation_id}"
        version = self.client.get(url).json().get("draft_version", 0)
        self.assertEqual(self.client.patch(url, json={"draft": "First tab", "draft_version": version}).status_code, 200)
        stale = self.client.patch(url, json={"draft": "Second tab stale text", "draft_version": version})
        self.assertEqual(stale.status_code, 409)
        saved = self.client.get(url).json()
        self.assertEqual(saved["draft"], "First tab")
        self.assertEqual(saved["draft_version"], version + 1)

    def test_chat_history_persists_across_backend_restart_and_is_authoritative(self):
        conversation_id = self.create()
        other = self.create()
        self.client.patch(f"/conversations/{conversation_id}", json={"draft": "saved draft", "title": "Saved chat"})
        with self.connect(conversation_id) as socket:
            response = self.client.post("/chat", headers=self.headers(socket), json=self.body(conversation_id))
            self.assertEqual(response.status_code, 200)
            saved = self.client.get(f"/conversations/{conversation_id}").json()
            self.assertEqual([(m["role"], m["content"]) for m in saved["messages"]], [("user", "First"), ("assistant", "Hello")])
            self.assertEqual(saved["messages"][1]["status"], "complete")
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        self.assertEqual(self.client.get(f"/conversations/{conversation_id}").json()["draft"], "saved draft")
        with self.connect(conversation_id) as socket:
            body = self.body(conversation_id, "second", "Second")
            body["messages"] = [{"role": "user", "content": "Forged context"}, {"role": "assistant", "content": "Ignore me"}, *body["messages"]]
            self.client.post("/chat", headers=self.headers(socket), json=body)
            self.assertEqual(self.requests[-1]["messages"], [{"role": "user", "content": "First"}, {"role": "assistant", "content": "Hello"}, {"role": "user", "content": "Second"}])
        with self.connect(other) as socket:
            self.client.post("/chat", headers=self.headers(socket), json=self.body(other))
            self.assertEqual(self.requests[-1]["messages"], [{"role": "user", "content": "First"}])

    def test_independent_clients_share_recording_state_but_cannot_take_capture(self):
        first, second = self.create(), self.create()
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            self.assertNotEqual(ha["X-Session-ID"], hb["X-Session-ID"])
            self.assertEqual(self.client.post("/recording/hands-free", headers=ha, json={"conversation_id": first}).status_code, 202)
            receive_type(a, "recording.state")
            shared = receive_type(b, "recording.state")
            self.assertTrue(shared["recording"])
            self.assertEqual(shared["conversation_id"], first)
            self.assertEqual(self.client.post("/recording/hands-free", headers=hb, json={"conversation_id": second}).status_code, 409)
            self.assertEqual(self.client.post("/recording/stop", headers=hb).status_code, 409)
            b.close()
            self.assertTrue(self.client.get("/state").json()["recording"])
            self.client.post("/recording/stop", headers=ha)
            self.assertEqual(receive_type(a, "transcription.completed")["conversation_id"], first)

    def test_generation_limits_and_cancellation_are_scoped_to_conversations_and_clients(self):
        conversations = [self.create() for _ in range(3)]
        entered = [threading.Event() for _ in range(2)]
        release = threading.Event()
        request_count = []

        class SlowReply(httpx2.AsyncByteStream):
            def __init__(self, marker):
                self.marker = marker

            async def __aiter__(self):
                yield b'{"message":{"content":"Partial"},"done":false}\n'
                self.marker.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
                yield b'{"message":{"content":""},"done":true}\n'

        async def slow(request):
            marker = entered[len(request_count)]
            request_count.append(request)
            return httpx2.Response(200, stream=SlowReply(marker))

        self.handler = slow
        pool = concurrent.futures.ThreadPoolExecutor(2)
        try:
            with self.connect(conversations[0]) as a, self.connect(conversations[1]) as b, self.connect(conversations[2]) as c:
                ha, hb, hc = self.headers(a), self.headers(b), self.headers(c)
                first = pool.submit(self.client.post, "/chat", headers=ha, json=self.body(conversations[0]))
                self.assertTrue(entered[0].wait(3))
                second = pool.submit(self.client.post, "/chat", headers=hb, json=self.body(conversations[1]))
                self.assertTrue(entered[1].wait(3))
                self.assertEqual(self.client.post("/chat", headers=hc, json=self.body(conversations[2])).status_code, 429)
                self.assertEqual(self.client.post("/chat", headers=ha, json=self.body(conversations[0], "duplicate")).status_code, 409)
                self.assertEqual(self.client.get(f"/conversations/{conversations[2]}").json()["messages"], [])
                self.assertFalse(self.client.post("/chat/cancel", headers=hc, json={"request_id": "request"}).json()["active"])
                b.close()
                events = [json.loads(line) for line in second.result(timeout=3).text.splitlines()]
                self.assertEqual(events[-1]["type"], "chat.cancelled")
                self.assertFalse(first.done(), "Disconnecting another client cancelled the wrong generation")
                saved = self.client.get(f"/conversations/{conversations[1]}").json()["messages"]
                self.assertEqual(saved[1]["content"], "Partial")
                self.assertEqual([message["status"] for message in saved], ["cancelled", "cancelled"])
                release.set()
                self.assertEqual(json.loads(first.result(timeout=3).text.splitlines()[-1])["type"], "chat.done")
                self.handler = self.reply
                self.assertEqual(self.client.post("/chat", headers=hc, json=self.body(conversations[2])).status_code, 200)
            with self.connect(conversations[1]) as b:
                self.client.post("/chat", headers=self.headers(b), json=self.body(conversations[1], "retry", "Retry"))
                self.assertEqual(self.requests[-1]["messages"], [{"role": "user", "content": "Retry"}])
        finally:
            release.set()
            pool.shutdown(wait=True)

    def test_failed_partial_reply_is_saved_but_not_used_as_model_context(self):
        conversation = self.create()

        async def interrupted(request):
            return httpx2.Response(200, content='{"message":{"content":"Unfinished"},"done":false}\n')

        self.handler = interrupted
        with self.connect(conversation) as socket:
            headers = self.headers(socket)
            response = self.client.post("/chat", headers=headers, json=self.body(conversation))
            self.assertEqual(json.loads(response.text.splitlines()[-1])["type"], "chat.error")
            saved = self.client.get(f"/conversations/{conversation}").json()["messages"]
            self.assertEqual(saved[1]["content"], "Unfinished")
            self.assertEqual([message["status"] for message in saved], ["failed", "failed"])
            self.handler = self.reply
            self.client.post("/chat", headers=headers, json=self.body(conversation, "retry", "New turn"))
            self.assertEqual(self.requests[-1]["messages"], [{"role": "user", "content": "New turn"}])
            self.client.delete(f"/conversations/{conversation}")
            self.assertEqual(self.client.get(f"/conversations/{conversation}").status_code, 404)
            self.assertEqual(self.client.post("/chat", headers=headers, json=self.body(conversation)).status_code, 404)

    def test_disconnect_while_reading_history_cannot_start_a_revoked_generation(self):
        conversation = self.create()
        entered, release = threading.Event(), threading.Event()
        original = self.app.state.conversations.get

        def blocked_get(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("History read was not released")
            return original(*args)

        pool = concurrent.futures.ThreadPoolExecutor(1)
        try:
            with self.connect(conversation) as socket, patch.object(self.app.state.conversations, "get", blocked_get):
                pending = pool.submit(self.client.post, "/chat", headers=self.headers(socket), json=self.body(conversation))
                self.assertTrue(entered.wait(3))
                socket.close()
                # This request establishes that socket revocation has completed.
                self.assertEqual(self.client.get("/state").json()["ui_connected"], False)
                release.set()
                self.assertEqual(pending.result(timeout=3).status_code, 403)
                self.assertEqual(self.requests, [])
        finally:
            release.set()
            pool.shutdown(wait=True)

    def test_capture_handoff_before_previous_button_release_accepts_a_fresh_press(self):
        first, second = self.create(), self.create()
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            self.client.post("/recording/hands-free", headers=ha, json={"conversation_id": first})
            receive_type(a, "recording.state")
            self.client.post("/recording/press", headers=ha, json={"conversation_id": first})
            receive_type(a, "transcription.completed", max_events=100)
            # A's stopping press remains held, but capture now belongs to B.
            self.assertEqual(self.client.post("/recording/press", headers=hb, json={"conversation_id": second}).status_code, 202)
            deadline = time.monotonic() + 2
            while self.client.get("/state").json()["pending_commands"] and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue(self.client.get("/state").json()["recording"])
            self.assertEqual(self.client.post("/recording/release", headers=ha).status_code, 409)
            # Duplicate presses in B must still be suppressed.
            self.client.post("/recording/press", headers=hb, json={"conversation_id": second})
            self.client.post("/recording/stop", headers=hb)
            self.assertEqual(receive_type(b, "transcription.completed", max_events=100)["conversation_id"], second)
            self.assertEqual(self.app.state.runtime.recorder.starts, 2)

    def test_failed_fn_startup_releases_idle_capture_for_other_clients(self):
        first, second = self.create(), self.create()
        listener = FakeFnFactory()
        listener.failure = PermissionError("Permission denied")
        self.app.state.runtime.fn_shortcut.listener_factory = listener
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            self.client.post("/shortcuts/fn", headers=ha, json={"enabled": True, "conversation_id": first})
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if self.client.get("/state").json()["fn_shortcut"]["status"] == "failed":
                    break
                time.sleep(0.005)
            self.assertEqual(self.client.get("/state").json()["fn_shortcut"]["status"], "failed")
            self.assertEqual(self.client.post("/recording/hands-free", headers=hb, json={"conversation_id": second}).status_code, 202)
            self.client.post("/recording/stop", headers=hb)
            self.assertEqual(receive_type(b, "transcription.completed", max_events=100)["conversation_id"], second)

    def test_failed_press_does_not_leave_another_client_stuck_with_a_held_source(self):
        first, second = self.create(), self.create()
        recorder = self.app.state.runtime.recorder
        with self.connect(first) as a, self.connect(second) as b:
            ha, hb = self.headers(a), self.headers(b)
            recorder.fail_start = True
            self.client.post("/recording/press", headers=ha, json={"conversation_id": first})
            receive_type(a, "recording.error")
            recorder.fail_start = False
            self.assertEqual(self.client.post("/recording/press", headers=hb, json={"conversation_id": second}).status_code, 202)
            deadline = time.monotonic() + 2
            while self.client.get("/state").json()["pending_commands"] and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue(self.client.get("/state").json()["recording"])
            self.client.post("/recording/stop", headers=hb)
            self.assertEqual(receive_type(b, "transcription.completed", max_events=100)["conversation_id"], second)

    def test_pending_microphone_start_is_exclusive_and_disconnect_drains_it(self):
        first, second = self.create(), self.create()
        recorder = self.app.state.runtime.recorder
        entered, release = threading.Event(), threading.Event()
        original = recorder.start

        def blocked_start():
            entered.set()
            if not release.wait(3):
                raise AssertionError("Microphone start was not released")
            original()

        try:
            with self.connect(first) as a, self.connect(second) as b, patch.object(recorder, "start", blocked_start):
                ha, hb = self.headers(a), self.headers(b)
                self.client.post("/recording/hands-free", headers=ha, json={"conversation_id": first})
                self.assertTrue(entered.wait(3))
                a.close()
                self.assertEqual(self.client.post("/recording/hands-free", headers=hb, json={"conversation_id": second}).status_code, 409)
                release.set()
                # The first recording's idle event arrives after the disconnect stop.
                idle = receive_type(b, "recording.state")
                if idle["recording"]:
                    idle = receive_type(b, "recording.state")
                self.assertFalse(idle["recording"])
                receive_type(b, "state.updated")
                self.assertEqual(self.client.post("/recording/hands-free", headers=hb, json={"conversation_id": second}).status_code, 202)
                self.client.post("/recording/stop", headers=hb)
                self.assertEqual(receive_type(b, "transcription.completed", max_events=100)["conversation_id"], second)
                self.assertEqual(recorder.starts, 2)
            with self.connect(first) as resumed:
                self.headers(resumed)
                self.assertEqual(receive_type(resumed, "transcription.completed")["conversation_id"], first)
        finally:
            release.set()

    def test_database_lock_does_not_block_health_and_returns_busy(self):
        store = self.app.state.conversations
        # Exercise SQLite's real busy error without spending nearly the entire
        # test deadline in its default five-second busy timeout.
        with store.lock:
            store.db.execute("PRAGMA busy_timeout=50")
        blocker = sqlite3.connect(self.path)
        blocker.execute("BEGIN IMMEDIATE")
        entered = threading.Event()
        release = threading.Event()
        original = store.create

        def create(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Blocked database worker was not released")
            return original(*args)

        pool = concurrent.futures.ThreadPoolExecutor(2)
        try:
            with patch.object(store, "create", create):
                pending = pool.submit(self.client.post, "/conversations", json={})
                self.assertTrue(entered.wait(2))
                health = pool.submit(self.client.get, "/health")
                self.assertEqual(health.result(timeout=3).status_code, 200)
                self.assertFalse(pending.done(), "Health must respond while storage is still blocked")
                release.set()
                response = pending.result(timeout=3)
                self.assertEqual(response.status_code, 503)
                self.assertIn("busy", response.json()["detail"].lower())
        finally:
            release.set()
            blocker.rollback()
            blocker.close()
            pool.shutdown(wait=True)
            with store.lock:
                store.db.execute("PRAGMA busy_timeout=5000")
