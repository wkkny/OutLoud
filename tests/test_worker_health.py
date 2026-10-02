import json
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from voice_dump.runtime import RecordingRuntime, RuntimeUnavailable
from voice_dump.server import create_app

ORIGIN = {"Origin": "http://localhost:5173"}


@contextmanager
def backend_with_crashing_worker(name):
    crash = threading.Event()

    def target(*args):
        crash.wait()
        raise RuntimeError("simulated crash at /private/worker.py")

    app = create_app(lambda publish: RecordingRuntime(publish, **{f"{name}_target": target}))
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        try:
            yield client, crash
        finally:
            crash.set()


class WorkerHealthTests(unittest.TestCase):
    def test_worker_crashes_make_readiness_fail_and_reject_new_recordings(self):
        for name in ("recording", "transcription"):
            with self.subTest(worker=name), backend_with_crashing_worker(name) as (client, crash):
                with client.websocket_connect("ws://127.0.0.1:8765/events", headers=ORIGIN) as websocket:
                    ready = websocket.receive_json()
                    self.assertEqual(ready["type"], "session.ready")
                    self.assertTrue(ready["state"]["ready"])
                    headers = {**ORIGIN, "X-Session-ID": ready["session_id"]}
                    crash.set()
                    for _ in range(10):
                        event = websocket.receive_json()
                        if event["type"] == "worker.state" and event["worker"] == name:
                            break
                    else:
                        self.fail("No worker failure event")
                    self.assertEqual(event["status"], "failed")
                    self.assertEqual(event["error"]["type"], "RuntimeError")
                    response = client.get("/ready")
                    self.assertEqual(response.status_code, 503)
                    self.assertFalse(response.json()["ready"])
                    self.assertEqual(client.get("/health").status_code, 200)
                    self.assertEqual(client.post("/recording/press", headers=headers, json={"conversation_id": "chat-1"}).status_code, 503)
                    snapshot = client.get("/state").json()
                    self.assertEqual(snapshot["workers"][name]["status"], "failed")
                    self.assertNotIn("/private/worker.py", json.dumps(snapshot))
                    self.assertNotIn(ready["session_id"], json.dumps(snapshot))
                    if name == "transcription":
                        # A failed model worker must not prevent stopping the microphone.
                        self.assertEqual(client.post("/recording/stop", headers=headers).status_code, 202)

    def test_transcription_crash_clears_active_job_and_preserves_error_metadata(self):
        crash = threading.Event()
        processing = threading.Event()
        exited = threading.Event()

        def transcribe(recordings, publish):
            job = recordings.get()
            publish({
                "type": "transcription.started",
                "recording_id": job.path.parent.name,
                "conversation_id": job.conversation_id,
                "session_id": job.session_id,
            })
            processing.set()
            crash.wait()
            raise RuntimeError("simulated inference crash")

        def observe(event):
            if event["type"] == "worker.state" and event["worker"] == "transcription":
                exited.set()

        recorder = MagicMock()
        recorder.path = Path("recordings/recording-1/audio.wav")
        recorder.stop.return_value = recorder.path
        runtime = RecordingRuntime(observe, recorder, transcription_target=transcribe)
        runtime.start()
        try:
            runtime.command("press", "session", "chat-1")
            runtime.command("stop", "session")
            self.assertTrue(processing.wait(3))
            self.assertEqual(runtime.snapshot()["transcription"]["active_job"]["recording_id"], "recording-1")
            crash.set()
            self.assertTrue(exited.wait(3))
            state = runtime.snapshot()
            self.assertIsNone(state["transcription"]["active_job"])
            self.assertEqual(state["transcription"]["status"], "unavailable")
            self.assertEqual(state["errors"]["transcription"]["recording_id"], "recording-1")
            self.assertFalse(state["ready"])
        finally:
            crash.set()
            runtime.stop()

    def test_unexpected_clean_worker_exit_is_also_a_failure(self):
        runtime = RecordingRuntime(lambda event: None, recording_target=lambda *args: None)
        runtime.start()
        try:
            self.assertFalse(runtime.readiness()["ready"])
            worker = runtime.snapshot()["workers"]["recording"]
            self.assertEqual(worker["status"], "failed")
            self.assertEqual(worker["error"]["type"], "UnexpectedExit")
            with self.assertRaises(RuntimeUnavailable):
                runtime.command("press", "session", "chat")
        finally:
            runtime.stop()

    def test_shutdown_is_intentional_and_rejects_further_work(self):
        runtime = RecordingRuntime(lambda event: None)
        runtime.start()
        self.assertTrue(runtime.readiness()["ready"])
        runtime.stop()
        state = runtime.snapshot()
        self.assertTrue(state["shutting_down"])
        self.assertFalse(state["ready"])
        self.assertEqual(state["workers"]["recording"], {"status": "stopped", "error": None})
        self.assertEqual(state["workers"]["transcription"], {"status": "stopped", "error": None})
        with self.assertRaises(RuntimeUnavailable):
            runtime.command("press", "session", "chat")
        runtime.stop_recording("disconnected-session")
        runtime.stop()

    def test_pending_commands_include_in_progress_start_until_disconnect_stop_finishes(self):
        starting = threading.Event()
        finish_start = threading.Event()
        watch = threading.Event()
        drained = threading.Event()

        def start():
            starting.set()
            if not finish_start.wait(3):
                raise RuntimeError("test start timed out")

        def transcribe(recordings, publish):
            while True:
                job = recordings.get()
                if job is None:
                    return
                context = {"recording_id": job.path.parent.name, "conversation_id": job.conversation_id}
                publish({"type": "transcription.started", **context})
                publish({"type": "transcription.completed", "text": "", **context})

        def observe(event):
            if watch.is_set() and event["type"] == "state.updated" and event["state"]["pending_commands"] == 0:
                drained.set()

        recorder = MagicMock()
        recorder.path = Path("recordings/recording-1/audio.wav")
        recorder.start.side_effect = start
        recorder.stop.return_value = recorder.path
        runtime = RecordingRuntime(observe, recorder, transcription_target=transcribe)
        runtime.start()
        try:
            runtime.command("press", "session", "chat-1")
            self.assertTrue(starting.wait(3))
            state = runtime.snapshot()
            self.assertFalse(state["recording"])
            self.assertEqual(state["pending_commands"], 1)
            runtime.stop_recording("session")
            self.assertEqual(runtime.snapshot()["pending_commands"], 2)
            watch.set()
            finish_start.set()
            self.assertTrue(drained.wait(3))
            state = runtime.snapshot()
            self.assertEqual(state["pending_commands"], 0)
            self.assertFalse(state["recording"])
            recorder.stop.assert_called_once()
        finally:
            finish_start.set()
            runtime.stop()

    def test_snapshot_cannot_mutate_runtime_state(self):
        runtime = RecordingRuntime(lambda event: None)
        runtime.start()
        try:
            snapshot = runtime.snapshot()
            snapshot["workers"]["recording"]["status"] = "failed"
            snapshot["transcription"]["queued_jobs"].append({"recording_id": "fake"})
            self.assertTrue(runtime.readiness()["ready"])
            self.assertEqual(runtime.snapshot()["transcription"]["queued_jobs"], [])
        finally:
            runtime.stop()


if __name__ == "__main__":
    unittest.main()
