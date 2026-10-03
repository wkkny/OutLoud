import json
import sqlite3
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from test_fn_shortcut import FakeFnFactory
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.recorder = FakeRecorder(Path(self.directory.name))
        self.capture = FakeFnFactory()
        self.finish = threading.Event()
        self.model_patch = patch("outloud.transcription.whisper.load_model")
        self.model = self.model_patch.start().return_value
        self.addCleanup(self.model_patch.stop)

        def transcribe(*args, **kwargs):
            if not self.finish.wait(5):
                raise RuntimeError("test inference timed out")
            return {"text": "Capacity test"}

        self.model.transcribe.side_effect = transcribe
        app = create_app(lambda publish: RecordingRuntime(
            publish, self.recorder, max_transcriptions=2, fn_listener_factory=self.capture,
            delivery_path=Path(self.directory.name) / "delivery" / "inbox.sqlite3",
        ))
        self.client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.runtime = app.state.runtime
        self.addCleanup(lambda: self.client.__exit__(None, None, None))
        self.addCleanup(self.finish.set)

    def wait_state(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.client.get("/state").json()
            if predicate(state):
                return state
            time.sleep(0.005)
        self.fail(f"State did not converge: {state}")

    def start_recording(self, headers):
        response = self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat"})
        self.assertEqual(response.status_code, 202)
        return self.wait_state(lambda state: state["recording"] and state["pending_commands"] == 0)

    def test_active_queued_and_recording_work_share_capacity_and_completion_reopens_it(self):
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            state = self.start_recording(headers)
            self.assertEqual(state["capacity"], {"limit": 2, "used": 1, "available": 1})
            self.client.post("/recording/stop", headers=headers)
            self.wait_state(lambda state: state["transcription"]["active_job"] is not None)
            state = self.start_recording(headers)
            self.assertEqual(state["capacity"]["available"], 0)
            self.assertEqual(self.client.post("/recording/stop", headers=headers).status_code, 202)
            self.wait_state(lambda state: len(state["transcription"]["queued_jobs"]) == 1)
            for action in ("press", "hands-free"):
                response = self.client.post(f"/recording/{action}", headers=headers, json={"conversation_id": "chat"})
                self.assertEqual(response.status_code, 429)
            state = self.client.get("/state").json()
            self.assertTrue(state["ui_connected"])
            self.assertTrue(state["ready"])
            self.assertEqual(self.recorder.starts, 2)
            self.finish.set()
            self.wait_state(lambda state: state["capacity"]["used"] == 0)
            self.start_recording(headers)
            self.assertEqual(self.recorder.starts, 3)

    def test_rapid_pending_starts_are_rechecked_before_opening_the_microphone(self):
        opened = threading.Event()
        resume = threading.Event()
        self.addCleanup(resume.set)
        original_start = self.recorder.start

        def delayed_start():
            opened.set()
            if not resume.wait(5):
                raise RuntimeError("test microphone timed out")
            original_start()

        self.recorder.start = delayed_start
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            try:
                self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat"})
                self.assertTrue(opened.wait(3))
                for _ in range(2):
                    self.client.post("/recording/stop", headers=headers)
                    self.assertEqual(self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat"}).status_code, 202)
                self.client.post("/recording/stop", headers=headers)
                resume.set()
                state = self.wait_state(lambda state: not state["recording"] and state["pending_commands"] == 0)
                self.assertEqual(self.recorder.starts, 2)
                self.assertEqual(state["capacity"]["used"], 2)
                self.assertIn("capacity is full", receive_type(socket, "recording.rejected", max_events=100)["message"])
                self.assertFalse((Path(self.directory.name) / "recording-3").exists())
            finally:
                resume.set()

    def test_failed_microphone_start_releases_its_slot_for_retry(self):
        self.recorder.fail_start = True
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat"})
            receive_type(socket, "recording.error")
            state = self.wait_state(lambda state: state["pending_commands"] == 0)
            self.assertEqual(state["capacity"]["used"], 0)
            self.recorder.fail_start = False
            self.assertEqual(self.start_recording(headers)["capacity"]["used"], 1)

    def test_delivery_storage_failure_preserves_audio_and_text_and_releases_capacity(self):
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            self.start_recording(headers)
            # Block rollback-journal creation without deleting the open database,
            # which Windows forbids. Audio storage still works on every platform.
            (Path(self.directory.name) / "delivery" / "inbox.sqlite3-journal").mkdir()
            self.finish.set()
            self.client.post("/recording/stop", headers=headers)
            receive_type(socket, "transcription.error", max_events=80)
            self.wait_state(lambda state: state["capacity"]["used"] == 0)
            folder = Path(self.directory.name) / "recording-1"
            deadline = time.monotonic() + 3
            while not (folder / "metrics.json").exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue((folder / "audio.wav").exists())
            self.assertEqual((folder / "transcript.txt").read_text().strip(), "Capacity test")
            self.assertEqual(json.loads((folder / "metrics.json").read_text())["status"], "failed")

    def test_large_replay_with_prompt_acknowledgements_does_not_overflow(self):
        for index in range(300):
            self.runtime.publish({"type": "transcription.completed", "recording_id": str(index), "conversation_id": "chat", "text": "Replay"})
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            receive_type(socket, "session.ready")
            acknowledged = set()
            while len(acknowledged) < 300:
                event = socket.receive_json()
                if event["type"] == "transcription.completed":
                    socket.send_json({"type": "transcript.ack", "recording_id": event["recording_id"], "conversation_id": "chat"})
                elif event["type"] == "transcript.acknowledged":
                    acknowledged.add(event["recording_id"])
            self.assertTrue(self.client.get("/state").json()["ui_connected"])

    def test_slow_acknowledgement_storage_does_not_delay_heartbeat_replies(self):
        self.finish.set()
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            self.start_recording(headers)
            self.client.post("/recording/stop", headers=headers)
            completed = receive_type(socket, "transcription.completed", max_events=80)
            database = sqlite3.connect(Path(self.directory.name) / "delivery" / "inbox.sqlite3", check_same_thread=False)
            database.execute("BEGIN EXCLUSIVE")
            release = threading.Timer(1, database.rollback)
            release.start()
            try:
                started = time.monotonic()
                socket.send_json({"type": "transcript.ack", "recording_id": completed["recording_id"], "conversation_id": "chat"})
                socket.send_json({"type": "session.ping", "id": 17})
                self.assertEqual(receive_type(socket, "session.pong", max_events=80)["id"], 17)
                self.assertLess(time.monotonic() - started, 0.5, "SQLite acknowledgement blocked heartbeat processing")
                receive_type(socket, "transcript.acknowledged", max_events=80)
            finally:
                release.join(3)
                database.close()

    def test_fn_can_stop_at_capacity_and_rejection_keeps_shortcut_enabled(self):
        with self.client.websocket_connect("/events?conversation_id=chat", headers=ORIGIN) as socket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(socket, "session.ready")["session_id"]}
            self.start_recording(headers)
            self.client.post("/recording/stop", headers=headers)
            self.wait_state(lambda state: state["transcription"]["active_job"] is not None)
            self.start_recording(headers)
            self.client.post("/shortcuts/fn", headers=headers, json={"enabled": True, "conversation_id": "chat"})
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            capture = self.capture.instances[-1]
            self.assertTrue(capture.on_key(True, time.monotonic()))
            self.wait_state(lambda state: not state["recording"] and state["pending_commands"] == 0)
            self.assertTrue(capture.on_key(False, time.monotonic()))
            self.wait_state(lambda state: state["pending_commands"] == 0)
            self.assertTrue(capture.on_key(True, time.monotonic()))
            rejected = receive_type(socket, "recording.rejected", max_events=80)
            self.assertIn("capacity is full", rejected["message"])
            self.assertEqual(self.recorder.starts, 2)
            self.assertEqual(self.client.get("/state").json()["fn_shortcut"]["status"], "enabled")
            self.assertTrue(capture.on_key(False, time.monotonic()))


if __name__ == "__main__":
    unittest.main()
