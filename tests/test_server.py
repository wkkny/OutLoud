import json
import threading
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from outloud.runtime import RecordingRuntime
from outloud.server import create_app

ORIGIN = {"Origin": "http://localhost:5173"}


class FakeRecorder:
    def __init__(self, folder):
        self.folder = folder
        self.starts = 0
        self.fail_start = False

    def start(self):
        if self.fail_start:
            raise RuntimeError("microphone unavailable")
        self.starts += 1
        self.path = self.folder / f"recording-{self.starts}" / "audio.wav"
        self.path.parent.mkdir()
        with wave.open(str(self.path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x00\x00" * 160)

    def check_health(self):
        pass

    def stop(self):
        return self.path


def receive_type(websocket, event_type, max_events=20):
    for _ in range(max_events):
        event = websocket.receive_json()
        if event["type"] == event_type:
            return event
    raise AssertionError(f"Did not receive {event_type}")


class LocalTestClient(TestClient):
    def websocket_connect(self, url, **kwargs):
        # Starlette defaults WebSockets to testserver, ignoring HTTP base_url.
        return super().websocket_connect("ws://127.0.0.1:8765" + url, **kwargs)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.recorder = FakeRecorder(Path(self.directory.name))
        self.model_patch = patch("outloud.transcription.whisper.load_model")
        load = self.model_patch.start()
        load.return_value.transcribe.return_value = {"text": " Hello from voice. "}
        self.model = load.return_value
        app = create_app(lambda publish: RecordingRuntime(publish, self.recorder))
        self.client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.client_closed = False

    def tearDown(self):
        if not self.client_closed:
            self.client.__exit__(None, None, None)
        self.model_patch.stop()
        self.directory.cleanup()

    def test_health_and_recording_state(self):
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        state = self.client.get("/state").json()
        self.assertFalse(state["recording"])
        self.assertFalse(state["ui_connected"])
        self.assertIsNone(state["recording_id"])
        self.assertEqual(state["transcription"], {"status": "idle", "active_job": None, "queued_jobs": []})
        self.assertTrue(state["ready"])
        self.assertEqual(self.client.get("/ready").status_code, 200)

    def test_session_ready_matches_http_snapshot(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            ready = receive_type(websocket, "session.ready")
            snapshot = ready["state"]
            self.assertEqual(snapshot, self.client.get("/state", headers={"X-Session-ID": ready["session_id"]}).json())
            self.assertTrue(snapshot["ui_connected"])
            encoded = json.dumps(snapshot)
            self.assertNotIn("session_id", encoded)
            self.assertNotIn("path", encoded)

    def test_active_and_queued_jobs_are_visible_without_transcript_content(self):
        finish = threading.Event()

        def transcribe(*args, **kwargs):
            if not finish.wait(5):
                raise RuntimeError("test transcription timed out")
            return {"text": "Private transcript text"}

        self.model.transcribe.side_effect = transcribe
        try:
            with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
                headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
                self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
                state = receive_type(websocket, "recording.state")
                while not state["recording"]:
                    state = receive_type(websocket, "recording.state")
                self.assertEqual(state["recording_id"], "recording-1")
                self.assertEqual(self.client.get("/state").json()["mode"], "hold")
                self.client.post("/recording/stop", headers=headers)
                receive_type(websocket, "transcription.started")
                self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-2"})
                state = receive_type(websocket, "recording.state")
                while not state["recording"]:
                    state = receive_type(websocket, "recording.state")
                self.client.post("/recording/stop", headers=headers)
                receive_type(websocket, "transcription.queued")
                snapshot = self.client.get("/state").json()
                self.assertEqual(snapshot["transcription"]["status"], "processing")
                self.assertEqual(snapshot["transcription"]["active_job"], {"recording_id": "recording-1", "conversation_id": "chat-1"})
                self.assertEqual(snapshot["transcription"]["queued_jobs"], [{"recording_id": "recording-2", "conversation_id": "chat-2"}])
                self.assertNotIn(self.directory.name, json.dumps(snapshot))
                finish.set()
                completed = 0
                for _ in range(30):
                    event = websocket.receive_json()
                    if event["type"] == "transcription.completed":
                        completed += 1
                    if completed == 2:
                        break
                self.assertEqual(completed, 2)
                state = self.client.get("/state").json()
                self.assertEqual(state["transcription"], {"status": "idle", "active_job": None, "queued_jobs": []})
                self.assertGreater(state["revision"], snapshot["revision"])
                self.assertNotIn("Private transcript text", json.dumps(state))
        finally:
            finish.set()

    def test_transcription_failure_clears_active_job_and_keeps_backend_ready(self):
        self.model.transcribe.side_effect = RuntimeError("failed at /private/model.bin")
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            self.client.post("/recording/stop", headers=headers)
            receive_type(websocket, "transcription.error")
            snapshot = self.client.get("/state").json()
            self.assertIsNone(snapshot["transcription"]["active_job"])
            self.assertEqual(snapshot["transcription"]["status"], "idle")
            self.assertEqual(snapshot["errors"]["transcription"]["recording_id"], "recording-1")
            self.assertNotIn("/private/model.bin", json.dumps(snapshot))
            self.assertEqual(self.client.get("/ready").status_code, 200)

    def test_http_and_websocket_reject_untrusted_origin(self):
        response = self.client.get("/state", headers={"Origin": "https://unrelated.example"})
        self.assertEqual(response.status_code, 403)
        for headers in ({}, {"Origin": "https://unrelated.example"}):
            with self.assertRaises(WebSocketDisconnect) as failure:
                with self.client.websocket_connect("/events", headers=headers):
                    pass
            self.assertEqual(failure.exception.code, 1008)

    def test_rejects_untrusted_host(self):
        self.assertEqual(self.client.get("/health", headers={"Host": "unrelated.example"}).status_code, 400)

    def test_recording_requires_connected_owner_and_correct_token(self):
        response = self.client.post("/recording/press", json={"conversation_id": "chat-1"}, headers=ORIGIN)
        self.assertEqual(response.status_code, 403)
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            ready = receive_type(websocket, "session.ready")
            response = self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": "wrong"})
            self.assertEqual(response.status_code, 403)
            self.assertTrue(self.client.get("/state").json()["ui_connected"])
            response = self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": ready["session_id"]})
            self.assertEqual(response.status_code, 202)

    def test_tabs_connect_independently_and_disconnect_invalidates_only_own_token(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            token = receive_type(websocket, "session.ready")["session_id"]
            with self.client.websocket_connect("/events", headers=ORIGIN) as other:
                other_token = receive_type(other, "session.ready")["session_id"]
                self.assertNotEqual(other_token, token)
            self.assertEqual(self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": token}).status_code, 202)
            self.assertEqual(self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": other_token}).status_code, 403)
        self.assertFalse(self.client.get("/state").json()["ui_connected"])
        self.assertEqual(self.client.post("/recording/stop", headers={**ORIGIN, "X-Session-ID": token}).status_code, 403)
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            self.assertNotEqual(receive_type(websocket, "session.ready")["session_id"], token)

    def test_recording_commands_deliver_status_and_transcript_to_conversation(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            response = self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            self.assertEqual(response.status_code, 202)
            state = receive_type(websocket, "recording.state")
            while not state["recording"]:
                state = receive_type(websocket, "recording.state")
            self.assertEqual(state["conversation_id"], "chat-1")
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-2"})
            self.client.post("/recording/stop", headers=headers)
            transcript = receive_type(websocket, "transcription.completed")
            self.assertEqual(transcript["text"], "Hello from voice.")
            self.assertEqual(transcript["conversation_id"], "chat-1")
            self.assertEqual(transcript["recording_id"], "recording-1")
            self.assertNotIn("session_id", transcript)
            self.assertEqual(self.recorder.starts, 1)

    def test_explicit_hands_free_is_idempotent_and_does_not_require_double_tap(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            for _ in range(2):
                response = self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat-1"})
                self.assertEqual(response.status_code, 202)
            state = receive_type(websocket, "recording.state")
            while not state["hands_free"]:
                state = receive_type(websocket, "recording.state")
            self.assertTrue(state["recording"])
            self.client.post("/recording/stop", headers=headers)
            self.assertEqual(receive_type(websocket, "transcription.completed")["conversation_id"], "chat-1")
            self.assertEqual(self.recorder.starts, 1)

    def test_explicit_hands_free_can_promote_a_hold_without_creating_another_recording(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            state = receive_type(websocket, "recording.state")
            while not state["recording"]:
                state = receive_type(websocket, "recording.state")
            self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "chat-2"})
            state = receive_type(websocket, "recording.state")
            while not state["hands_free"]:
                state = receive_type(websocket, "recording.state")
            self.assertEqual(state["conversation_id"], "chat-1")
            self.client.post("/recording/release", headers=headers)
            self.client.post("/recording/stop", headers=headers)
            self.assertEqual(receive_type(websocket, "transcription.completed")["conversation_id"], "chat-1")
            self.assertEqual(self.recorder.starts, 1)

    def test_explicit_hands_free_requires_owner_and_conversation(self):
        self.assertEqual(self.client.post("/recording/hands-free", headers=ORIGIN, json={"conversation_id": "chat-1"}).status_code, 403)
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            self.assertEqual(self.client.post("/recording/hands-free", headers=headers, json={}).status_code, 422)

    def test_double_tap_keeps_one_hands_free_recording(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            for _ in range(2):
                self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
                self.client.post("/recording/release", headers=headers)
            state = receive_type(websocket, "recording.state")
            while not state["hands_free"]:
                state = receive_type(websocket, "recording.state")
            self.assertTrue(state["recording"])
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            self.assertEqual(receive_type(websocket, "transcription.completed")["text"], "Hello from voice.")
            self.assertEqual(self.recorder.starts, 1)

    def test_microphone_failure_is_published_and_next_attempt_succeeds(self):
        self.recorder.fail_start = True
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            error = receive_type(websocket, "recording.error")
            self.assertIn("microphone unavailable", error["message"])
            snapshot = self.client.get("/state").json()
            self.assertIsNotNone(snapshot["errors"]["recording"])
            self.assertFalse(snapshot["recording"])
            self.assertEqual(self.client.get("/ready").status_code, 200)
            self.client.post("/recording/release", headers=headers)
            self.recorder.fail_start = False
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            state = receive_type(websocket, "recording.state")
            while not state["recording"]:
                state = receive_type(websocket, "recording.state")
            self.client.post("/recording/stop", headers=headers)
            self.assertEqual(receive_type(websocket, "transcription.completed")["text"], "Hello from voice.")

    def test_disconnect_finalizes_recording(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"})
            state = receive_type(websocket, "recording.state")
            while not state["recording"]:
                state = receive_type(websocket, "recording.state")
        # Lifespan shutdown drains the disconnect command and transcription job.
        # Simulate a lost release: closing the owner socket must invalidate late presses.
        self.assertEqual(self.client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"}).status_code, 403)
        self.client.__exit__(None, None, None)
        self.client_closed = True
        self.assertEqual(self.recorder.starts, 1)
        self.assertTrue((self.recorder.path.parent / "transcript.txt").exists())


if __name__ == "__main__":
    unittest.main()
