import asyncio
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from starlette.websockets import WebSocket

from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


def level_event(level=0.5, recording_id="recording-one", session_id="owner"):
    return {"type": "recording.level", "recording_id": recording_id,
            "session_id": session_id, "level": level}


class RuntimeLevelTests(unittest.TestCase):
    def test_invalid_telemetry_is_dropped_without_changing_state(self):
        published = []
        runtime = RecordingRuntime(published.append)
        self.addCleanup(runtime.transcripts.close)
        before = runtime.snapshot()
        invalid = [level_event(value) for value in (float("nan"), float("inf"), -0.1, 1.1, True, "0.5", None)]
        invalid.extend(level_event(recording_id=value) for value in (None, "", 123))
        invalid.extend(level_event(session_id=value) for value in (None, "", 123))
        for event in invalid:
            with self.subTest(event=event):
                runtime.publish(event)
        self.assertEqual(published, [])
        self.assertEqual(runtime.snapshot(), before)

    def test_levels_are_live_events_without_snapshot_changes_or_replay(self):
        published = []
        runtime = RecordingRuntime(published.append)
        self.addCleanup(runtime.transcripts.close)
        before = runtime.snapshot()
        event = level_event()
        runtime.publish(event)
        self.assertEqual(published, [event])
        self.assertEqual(runtime.snapshot(), before)
        self.assertEqual(list(runtime.transcripts.replay()), [])


class ServerLevelTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.recorder = FakeRecorder(Path(self.directory.name))
        self.model_patch = patch("outloud.transcription.whisper.load_model")
        self.model_patch.start().return_value.transcribe.return_value = {"text": ""}
        app = create_app(lambda publish: RecordingRuntime(publish, self.recorder))
        self.client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.runtime = app.state.runtime

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.model_patch.stop()
        self.directory.cleanup()

    def start_recording(self, socket):
        session_id = receive_type(socket, "session.ready")["session_id"]
        self.client.post("/recording/hands-free", headers={**ORIGIN, "X-Session-ID": session_id},
                         json={"conversation_id": "chat"})
        for _ in range(20):
            event = socket.receive_json()
            if event["type"] == "state.updated" and event["state"]["recording"] and event["state"]["pending_commands"] == 0:
                return session_id
        self.fail("Recording did not start")

    def test_level_is_delivered_only_to_recording_owner_without_session_credentials(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as owner:
            session_id = self.start_recording(owner)
            with self.client.websocket_connect("/events", headers=ORIGIN) as peer:
                receive_type(peer, "session.ready")
                self.runtime.publish(level_event(0.25, "recording-1", session_id))
                self.assertEqual(receive_type(owner, "recording.level"), {
                    "type": "recording.level", "recording_id": "recording-1", "level": 0.25,
                })
                self.runtime.publish({"type": "test.barrier"})
                while True:
                    event = peer.receive_json()
                    self.assertNotEqual(event["type"], "recording.level")
                    if event["type"] == "test.barrier":
                        break

    def test_blocked_sender_keeps_latest_level_and_preserves_reliable_events(self):
        blocked = threading.Event()
        release = threading.Event()
        original_send = WebSocket.send_json

        async def blocked_send(websocket, event, mode="text"):
            if event["type"] == "test.blocked":
                blocked.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
            await original_send(websocket, event, mode)

        with patch.object(WebSocket, "send_json", blocked_send), self.client.websocket_connect("/events", headers=ORIGIN) as socket:
            session_id = self.start_recording(socket)
            headers = {"X-Session-ID": session_id}
            try:
                self.runtime.publish({"type": "test.blocked"})
                self.assertTrue(blocked.wait(3))
                before = self.client.get("/state", headers=headers).json()
                for index in range(1000):
                    self.runtime.publish(level_event(index / 1000, "recording-1", session_id))
                self.assertEqual(self.client.get("/state", headers=headers).json(), before)
                self.runtime.publish({"type": "test.reliable"})
                release.set()
                seen = {}
                while "recording.level" not in seen or "test.reliable" not in seen:
                    event = socket.receive_json()
                    self.assertNotEqual(event["type"], "connection.error")
                    seen[event["type"]] = event
                self.assertEqual(seen["recording.level"], {
                    "type": "recording.level", "recording_id": "recording-1", "level": 0.999,
                })
                self.assertTrue(self.client.get("/state", headers=headers).json()["client_connected"])
            finally:
                release.set()

    def test_stop_discards_level_waiting_for_a_blocked_sender(self):
        blocked = threading.Event()
        release = threading.Event()
        original_send = WebSocket.send_json

        async def blocked_send(websocket, event, mode="text"):
            if event["type"] == "test.blocked":
                blocked.set()
                while not release.is_set():
                    await asyncio.sleep(0.005)
            await original_send(websocket, event, mode)

        with patch.object(WebSocket, "send_json", blocked_send), self.client.websocket_connect("/events", headers=ORIGIN) as socket:
            session_id = self.start_recording(socket)
            try:
                self.runtime.publish({"type": "test.blocked"})
                self.assertTrue(blocked.wait(3))
                self.runtime.publish(level_event(0.5, "recording-1", session_id))
                self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": session_id})
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    state = self.client.get("/state").json()
                    if not state["recording"] and state["pending_commands"] == 0:
                        break
                    time.sleep(0.005)
                else:
                    self.fail("Recording did not stop")
                self.runtime.publish({"type": "test.barrier"})
                release.set()
                while True:
                    event = socket.receive_json()
                    self.assertNotEqual(event["type"], "recording.level")
                    if event["type"] == "test.barrier":
                        break
            finally:
                release.set()
