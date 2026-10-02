import asyncio
import queue
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from starlette.websockets import WebSocket, WebSocketDisconnect

from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from test_delivery import result
from test_fn_shortcut import FakeFnFactory
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.recorder = FakeRecorder(Path(self.directory.name))
        self.capture = FakeFnFactory()
        self.now = 0
        self.model_patch = patch("outloud.transcription.whisper.load_model")
        self.model = self.model_patch.start().return_value
        self.model.transcribe.return_value = {"text": "Replay me"}
        app = create_app(lambda publish: RecordingRuntime(
            publish, self.recorder, fn_listener_factory=self.capture,
        ), clock=lambda: self.now)
        self.client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.runtime = app.state.runtime

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.model_patch.stop()
        self.directory.cleanup()

    def connect(self, conversation_id="chat"):
        return self.client.websocket_connect(f"/events?conversation_id={conversation_id}", headers=ORIGIN)

    def headers(self, socket):
        return {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}

    def record(self, headers):
        self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat"})
        self.client.post("/recording/stop", headers=headers)

    def wait_state(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.client.get("/state").json()
            if predicate(state):
                return state
            time.sleep(0.005)
        self.fail(f"State did not converge: {state}")

    def test_unacknowledged_result_replays_and_acknowledged_result_does_not(self):
        with self.connect() as socket:
            headers = self.headers(socket)
            self.record(headers)
            original = receive_type(socket, "transcription.completed")
        with self.connect() as socket:
            self.headers(socket)
            replay = receive_type(socket, "transcription.completed")
            self.assertEqual(replay, original)
            self.assertNotIn("session_id", replay)
            socket.send_json({"type": "transcript.ack", "recording_id": replay["recording_id"], "conversation_id": "chat"})
            receive_type(socket, "transcript.acknowledged")
        with self.connect() as socket:
            self.headers(socket)
            socket.send_json({"type": "session.ping", "id": 1})
            while True:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "transcription.completed")
                if event["type"] == "session.pong":
                    break

    def test_duplicate_completion_cannot_restore_an_acknowledged_result_to_a_new_owner(self):
        completed = result("one", "chat")
        self.runtime.publish(completed)
        with self.connect() as socket:
            self.headers(socket)
            receive_type(socket, "transcription.completed")
            socket.send_json({"type": "transcript.ack", "recording_id": "one", "conversation_id": "chat"})
            receive_type(socket, "transcript.acknowledged")
        self.wait_state(lambda state: not state["ui_connected"] and state["pending_commands"] == 0)
        with self.connect() as socket:
            self.headers(socket)
            receive_type(socket, "state.updated")  # Drain the claim publication.
            self.runtime.publish(completed)
            while True:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "transcription.completed")
                if event["type"] == "state.updated":
                    break

    def test_completion_from_old_session_delivers_to_reconnected_original_conversation(self):
        finish = threading.Event()

        def transcribe(*args, **kwargs):
            if not finish.wait(3):
                raise RuntimeError("test transcription timed out")
            return {"text": "Completed offline"}

        self.model.transcribe.side_effect = transcribe
        try:
            with self.connect() as socket:
                self.record(self.headers(socket))
                receive_type(socket, "transcription.started")
            with self.connect() as socket:
                self.headers(socket)
                finish.set()
                completed = receive_type(socket, "transcription.completed")
                self.assertEqual(completed["conversation_id"], "chat")
                self.assertEqual(completed["text"], "Completed offline")
        finally:
            finish.set()

    def test_other_conversation_cannot_receive_or_acknowledge_result(self):
        self.runtime.publish(result("one", "chat"))
        with self.connect("other") as socket:
            self.headers(socket)
            socket.send_json({"type": "session.ping", "id": 1})
            while True:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "transcription.completed")
                if event["type"] == "session.pong":
                    break
            socket.send_json({"type": "transcript.ack", "recording_id": "one", "conversation_id": "chat"})
            with self.assertRaises(WebSocketDisconnect):
                while True:
                    socket.receive_json()
        with self.connect() as socket:
            self.headers(socket)
            self.assertEqual(receive_type(socket, "transcription.completed")["recording_id"], "one")

    def test_replay_larger_than_event_queue_does_not_overflow(self):
        for index in range(180):
            self.runtime.publish(result(str(index), "chat"))
        with self.connect() as socket:
            self.headers(socket)
            seen = []
            while len(seen) < 180:
                event = socket.receive_json()
                self.assertNotEqual(event["type"], "connection.error")
                if event["type"] == "transcription.completed":
                    seen.append(event["recording_id"])
            self.assertEqual(seen, [str(index) for index in range(180)])
            self.assertTrue(self.client.get("/state").json()["ui_connected"])

    def test_simultaneous_upgrades_can_only_claim_one_owner(self):
        accepted = []
        release_accept = threading.Event()
        keep_owner = threading.Event()
        results = queue.Queue()
        original_accept = WebSocket.accept

        async def simultaneous_accept(websocket, *args, **kwargs):
            await original_accept(websocket, *args, **kwargs)
            accepted.append(websocket)
            if len(accepted) == 2:
                release_accept.set()
            while not release_accept.is_set():
                await asyncio.sleep(0.005)

        def tab():
            try:
                with self.connect() as socket:
                    self.headers(socket)
                    results.put("owner")
                    keep_owner.wait(3)
            except WebSocketDisconnect:
                results.put("rejected")

        with patch.object(WebSocket, "accept", simultaneous_accept):
            tabs = [threading.Thread(target=tab) for _ in range(2)]
            for thread in tabs:
                thread.start()
            try:
                outcomes = [results.get(timeout=3) for _ in tabs]
                self.assertCountEqual(outcomes, ["owner", "rejected"])
                self.assertTrue(self.client.get("/state").json()["ui_connected"])
            finally:
                release_accept.set()
                keep_owner.set()
                for thread in tabs:
                    thread.join(3)
                    self.assertFalse(thread.is_alive())

    def test_blocked_ready_message_cannot_prevent_owner_lease_expiry(self):
        blocked = threading.Event()
        release = threading.Event()
        original_send = WebSocket.send_json

        async def blocked_ready(websocket, data, mode="text"):
            if data["type"] == "session.ready":
                blocked.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
            await original_send(websocket, data, mode)

        with patch.object(WebSocket, "send_json", blocked_ready), self.connect() as socket:
            try:
                self.assertTrue(blocked.wait(3))
                self.assertTrue(self.client.get("/state").json()["ui_connected"])
                # Allow claim publications to drain before advancing the lease.
                time.sleep(0.025)
                self.now = 91
                self.wait_state(lambda state: not state["ui_connected"])
            finally:
                release.set()

    def test_blocked_rejection_cannot_delay_current_owner_disconnect_cleanup(self):
        blocked = threading.Event()
        release = threading.Event()
        original_close = WebSocket.close

        async def slow_rejection(websocket, code=1000, reason=None):
            if code == 1008:
                blocked.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
            await original_close(websocket, code=code, reason=reason)

        def second_tab():
            try:
                with self.connect() as rejected:
                    self.headers(rejected)
            except WebSocketDisconnect:
                pass

        with patch.object(WebSocket, "close", slow_rejection), self.connect() as owner:
            headers = self.headers(owner)
            self.client.post("/shortcuts/fn", headers=headers, json={"enabled": True, "conversation_id": "chat"})
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            capture = self.capture.instances[-1]
            capture.on_key(True, time.monotonic())
            self.wait_state(lambda state: state["recording"] and state["pending_commands"] == 0)
            peer = threading.Thread(target=second_tab)
            peer.start()
            try:
                self.assertTrue(blocked.wait(3))
                owner.close()
                state = self.wait_state(lambda state: not state["ui_connected"] and not state["recording"] and state["pending_commands"] == 0)
                self.assertEqual(state["fn_shortcut"]["status"], "disabled")
                self.assertTrue(capture.closed.wait(3))
            finally:
                release.set()
                peer.join(3)
                self.assertFalse(peer.is_alive())

    def test_event_overflow_revokes_fn_even_when_socket_sending_is_blocked(self):
        original_send = WebSocket.send_json

        async def blocked_send(websocket, data, mode="text"):
            if data["type"] == "state.updated":
                await asyncio.Event().wait()
            await original_send(websocket, data, mode)

        with patch.object(WebSocket, "send_json", blocked_send), self.connect() as socket:
            headers = self.headers(socket)
            self.client.post("/shortcuts/fn", headers=headers, json={"enabled": True, "conversation_id": "chat"})
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            capture = self.capture.instances[-1]
            capture.on_key(True, time.monotonic())
            self.wait_state(lambda state: state["recording"] and state["pending_commands"] == 0)
            for index in range(200):
                self.runtime.publish(result(f"offline-{index}", "chat"))
            state = self.wait_state(lambda state: not state["ui_connected"] and not state["recording"] and state["pending_commands"] == 0)
            self.assertEqual(state["fn_shortcut"]["status"], "disabled")
            self.assertTrue(capture.closed.wait(3))
            self.assertFalse(capture.on_key(True, time.monotonic()))
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 403)
            self.assertGreaterEqual(len(self.runtime.transcripts.replay("chat")), 200)

    def test_heartbeat_reply_is_not_stuck_behind_a_slow_replay(self):
        for index in range(40):
            self.runtime.publish(result(str(index), "chat"))
        original_send = WebSocket.send_json

        async def slow_send(websocket, data, mode="text"):
            if data["type"] == "transcription.completed":
                await asyncio.sleep(0.02)
            await original_send(websocket, data, mode)

        with patch.object(WebSocket, "send_json", slow_send), self.connect() as socket:
            self.headers(socket)
            receive_type(socket, "transcription.completed")
            socket.send_json({"type": "session.ping", "id": 9})
            completed = 1
            while True:
                event = socket.receive_json()
                if event["type"] == "transcription.completed":
                    completed += 1
                if event["type"] == "session.pong":
                    self.assertEqual(event["id"], 9)
                    break
            self.assertLess(completed, 40)

    def test_heartbeat_renews_lease_but_expired_owner_cannot_renew_or_issue_commands(self):
        with self.connect() as socket:
            headers = self.headers(socket)
            self.now = 60
            socket.send_json({"type": "session.ping", "id": 7})
            self.assertEqual(receive_type(socket, "session.pong")["id"], 7)
            self.now = 140  # 80 seconds since the heartbeat, still valid.
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 202)
            self.now = 151
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 403)
            self.assertFalse(self.client.get("/state").json()["ui_connected"])
            socket.send_json({"type": "session.ping", "id": 8})
            with self.assertRaises(WebSocketDisconnect):
                while True:
                    event = socket.receive_json()
                    self.assertNotEqual(event, {"type": "session.pong", "id": 8})

    def test_expired_owner_releases_fn_and_cannot_revoke_replacement_owner(self):
        with self.connect() as old:
            old_headers = self.headers(old)
            body = {"enabled": True, "conversation_id": "chat"}
            self.client.post("/shortcuts/fn", headers=old_headers, json=body)
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            old_capture = self.capture.instances[-1]
            old_capture.on_key(True, time.monotonic())
            self.wait_state(lambda state: state["recording"])
            self.now = 91
            with self.connect() as replacement:
                headers = self.headers(replacement)
                self.wait_state(lambda state: not state["recording"] and state["pending_commands"] == 0)
                self.assertTrue(old_capture.closed.wait(3))
                self.assertFalse(old_capture.on_key(True, time.monotonic()))
                self.client.post("/shortcuts/fn", headers=headers, json=body)
                self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
                new_capture = self.capture.instances[-1]
                new_capture.on_key(True, time.monotonic())
                self.wait_state(lambda state: state["recording"] and state["pending_commands"] == 0)
                old.send_json({"type": "session.ping", "id": 1})
                with self.assertRaises(WebSocketDisconnect):
                    while True:
                        old.receive_json()
                state = self.client.get("/state").json()
                self.assertTrue(state["ui_connected"])
                self.assertTrue(state["recording"])
                self.assertEqual(state["fn_shortcut"]["status"], "enabled")
                self.assertEqual(self.client.post("/recording/stop", headers=old_headers).status_code, 403)

    def test_lease_watcher_stops_recording_without_any_http_request(self):
        with self.connect() as socket:
            headers = self.headers(socket)
            self.client.post("/shortcuts/fn", headers=headers, json={"enabled": True, "conversation_id": "chat"})
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            capture = self.capture.instances[-1]
            capture.on_key(True, time.monotonic())
            self.wait_state(lambda state: state["recording"] and state["pending_commands"] == 0)
            socket.send_json({"type": "session.ping", "id": 1})
            receive_type(socket, "session.pong")
            self.now = 91
            with self.assertRaises(WebSocketDisconnect):
                while True:
                    socket.receive_json()
            self.assertTrue(capture.closed.wait(3))
            state = self.wait_state(lambda state: not state["recording"] and state["pending_commands"] == 0)
            self.assertFalse(state["ui_connected"])
            self.assertEqual(state["fn_shortcut"]["status"], "disabled")

    def test_binary_messages_revoke_owner_without_an_unhandled_error(self):
        with self.connect() as socket:
            headers = self.headers(socket)
            socket.send_bytes(b"invalid")
            with self.assertRaises(WebSocketDisconnect) as closed:
                while True:
                    socket.receive_json()
            self.assertEqual(closed.exception.code, 1003)
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 403)

    def test_invalid_messages_do_not_keep_owner_alive(self):
        with self.connect() as socket:
            headers = self.headers(socket)
            socket.send_text("not JSON")
            with self.assertRaises(WebSocketDisconnect):
                while True:
                    socket.receive_json()
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 403)


if __name__ == "__main__":
    unittest.main()
