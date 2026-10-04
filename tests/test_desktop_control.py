import os
from io import StringIO
import sqlite3
import threading
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from outloud import server
from outloud.conversations import ConversationStore
from outloud.delivery import TranscriptInbox
from outloud.runtime import RecordingRuntime, RuntimeUnavailable


TOKEN = {"X-OutLoud-Desktop-Token": "owner-secret"}


class DesktopControlTests(unittest.TestCase):
    def make_app(self, **options):
        return server.create_app(lambda publish: RecordingRuntime(publish), **options)

    def test_desktop_controls_require_both_owner_configuration_arguments(self):
        for options in ({}, {"desktop_token": "owner-secret"}, {"request_shutdown": Mock()}):
            with self.subTest(options=options), TestClient(self.make_app(**options), base_url="http://127.0.0.1:8765") as client:
                self.assertEqual(client.get("/desktop/status", headers=TOKEN).status_code, 404)
                self.assertEqual(client.post("/desktop/shutdown", headers=TOKEN).status_code, 404)

    def test_desktop_controls_reject_missing_wrong_and_browser_credentials(self):
        shutdown = Mock()
        app = self.make_app(desktop_token="owner-secret", request_shutdown=shutdown)
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            for headers in ({}, {"X-OutLoud-Desktop-Token": "wrong"}, {"X-OutLoud-Desktop-Token": "owner-secret-extra"}):
                self.assertEqual(client.get("/desktop/status", headers=headers).status_code, 403)
                self.assertEqual(client.post("/desktop/shutdown", headers=headers).status_code, 403)
            for origin in ("http://127.0.0.1:5173", "http://localhost:5173", "https://evil.example", "null", ""):
                headers = {**TOKEN, "Origin": origin}
                self.assertEqual(client.get("/desktop/status", headers=headers).status_code, 403)
                self.assertEqual(client.post("/desktop/shutdown", headers=headers).status_code, 403)
                self.assertEqual(client.options("/desktop/shutdown", headers={**headers, "Access-Control-Request-Method": "POST"}).status_code, 403)
            shutdown.assert_not_called()
            self.assertFalse(app.state.runtime.shutting_down)

    def test_desktop_ui_origin_is_allowed_only_for_managed_backends(self):
        origin = {"Origin": "http://127.0.0.1:5174"}
        app = self.make_app(desktop_token="owner-secret", request_shutdown=Mock())
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            self.assertEqual(client.get("/state", headers=origin).status_code, 200)
            with client.websocket_connect("ws://127.0.0.1:8765/events", headers=origin) as websocket:
                self.assertEqual(websocket.receive_json()["type"], "session.ready")
            self.assertEqual(client.get("/state", headers={"Origin": "http://127.0.0.1:5175"}).status_code, 403)
        with TestClient(self.make_app(), base_url="http://127.0.0.1:8765") as client:
            self.assertEqual(client.get("/state", headers=origin).status_code, 403)

    def test_owner_status_and_shutdown_follow_runtime_readiness(self):
        shutdown = Mock()
        app = self.make_app(desktop_token="owner-secret", request_shutdown=shutdown)
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            status = client.get("/desktop/status", headers=TOKEN)
            self.assertEqual(status.status_code, 200)
            self.assertEqual(status.json(), {"status": "ready"})
            self.assertEqual(client.post("/desktop/shutdown", headers=TOKEN).status_code, 202)
            self.assertTrue(app.state.runtime.shutting_down)
            shutdown.assert_called_once_with()
            self.assertEqual(client.get("/desktop/status", headers=TOKEN).status_code, 503)

    def test_owner_status_is_unavailable_when_a_worker_has_exited(self):
        app = server.create_app(
            lambda publish: RecordingRuntime(publish, recording_target=lambda *args: None),
            desktop_token="owner-secret", request_shutdown=Mock(),
        )
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            app.state.runtime.threads["recording"].join()
            self.assertEqual(client.get("/desktop/status", headers=TOKEN).status_code, 503)

    def test_desktop_entrypoint_uses_server_with_owner_shutdown_callback(self):
        with patch.dict(os.environ, {"OUTLOUD_DESKTOP_TOKEN": "owner-secret"}), patch.object(server.uvicorn, "Server") as server_type, patch.object(server.uvicorn, "run") as run:
            server_type.return_value.should_exit = False
            server.main()
            configured = server_type.call_args.args[0]
            self.assertEqual((configured.host, configured.port), ("127.0.0.1", 8765))
            server_type.return_value.run.assert_called_once_with()
            self.assertFalse(server_type.return_value.should_exit)
            run.assert_not_called()
            # No lifespan yet: owner status must fail until workers are ready.
            client = TestClient(configured.app, base_url="http://127.0.0.1:8765")
            self.assertEqual(client.get("/desktop/status", headers=TOKEN).status_code, 503)
            runtime = RecordingRuntime(lambda event: None)
            configured.app.state.runtime = runtime
            runtime.start()
            try:
                self.assertEqual(client.get("/desktop/status", headers=TOKEN).json(), {"status": "ready"})
                self.assertEqual(client.post("/desktop/shutdown", headers=TOKEN).status_code, 202)
                self.assertIs(server_type.return_value.should_exit, True)
            finally:
                runtime.stop()
                client.close()

    def test_desktop_backend_shuts_down_when_its_owner_pipe_closes(self):
        with patch.dict(os.environ, {"OUTLOUD_DESKTOP_TOKEN": "owner-secret", "OUTLOUD_DESKTOP_PARENT_STDIN": "1"}), patch("sys.stdin", StringIO("")), patch.object(server.uvicorn, "Server") as server_type, patch("threading.Thread") as thread_type:
            server_type.return_value.should_exit = False
            thread_type.return_value.start.side_effect = lambda: thread_type.call_args.kwargs["target"]()
            server.main()
            self.assertTrue(server_type.return_value.should_exit)

    def test_shutdown_stops_capture_before_draining_and_persists_final_transcripts(self):
        processing = threading.Event()
        finish_transcribing = threading.Event()
        started = threading.Event()
        stopped = threading.Event()
        closed = threading.Event()
        errors = []
        recorder = Mock()
        recording_number = 0

        with TemporaryDirectory() as directory, patch("outloud.transcription.whisper.load_model") as load:
            folder = Path(directory)

            def start_recording():
                nonlocal recording_number
                recording_number += 1
                recorder.path = folder / f"recording-{recording_number}" / "audio.wav"
                recorder.path.parent.mkdir()
                with wave.open(str(recorder.path), "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16000)
                    audio.writeframes(b"\x00\x00" * 160)
                started.set()

            def stop_recording():
                stopped.set()
                return recorder.path

            def transcribe(*args, **kwargs):
                processing.set()
                finish_transcribing.wait()
                return {"text": " Saved speech. "}

            recorder.start.side_effect = start_recording
            recorder.stop.side_effect = stop_recording
            load.return_value.transcribe.side_effect = transcribe
            app = server.create_app(
                lambda publish: RecordingRuntime(publish, recorder, delivery_path=folder / "delivery.sqlite3"),
                conversations_path=folder / "conversations.sqlite3",
                desktop_token="owner-secret", request_shutdown=Mock(),
            )
            client = TestClient(app, base_url="http://127.0.0.1:8765")
            client.__enter__()
            runtime = app.state.runtime
            conversation_id = client.post("/conversations", json={}).json()["id"]

            def close_client():
                try:
                    client.__exit__(None, None, None)
                except BaseException as error:
                    errors.append(error)
                finally:
                    closed.set()

            closer = None
            try:
                runtime.command("press", "owner", conversation_id)
                self.assertTrue(started.wait(3))
                runtime.command("stop", "owner")
                self.assertTrue(processing.wait(3))
                started.clear()
                stopped.clear()
                runtime.command("hands-free", "owner", conversation_id)
                self.assertTrue(started.wait(3))
                self.assertEqual(client.post("/desktop/shutdown", headers=TOKEN).status_code, 202)
                self.assertTrue(stopped.wait(3))
                self.assertTrue(runtime.shutting_down)
                runtime.begin_shutdown()
                for action in ("press", "hands-free", "stop", "release"):
                    with self.assertRaises(RuntimeUnavailable):
                        runtime.command(action, "owner", conversation_id)
                with self.assertRaises(RuntimeUnavailable):
                    runtime.configure_fn("owner", True, conversation_id)
                closer = threading.Thread(target=close_client)
                closer.start()
                self.assertFalse(closed.wait(0.1))
                self.assertTrue(runtime.threads["transcription"].is_alive())
                self.assertFalse((folder / "recording-1" / "transcript.txt").exists())
            finally:
                finish_transcribing.set()
                if closer is None:
                    close_client()
                else:
                    closer.join(5)
            self.assertTrue(closed.is_set())
            self.assertEqual(errors, [])
            self.assertTrue(all(not thread.is_alive() for thread in runtime.threads.values()))
            self.assertTrue(runtime.events.empty())
            self.assertEqual(recorder.stop.call_count, 2)
            for number in (1, 2):
                self.assertEqual((folder / f"recording-{number}" / "transcript.txt").read_text(), "Saved speech.\n")
            inbox = TranscriptInbox(folder / "delivery.sqlite3")
            store = ConversationStore(folder / "conversations.sqlite3")
            try:
                self.assertEqual(len(list(inbox.replay(conversation_id))), 2)
                self.assertEqual(store.get(conversation_id)["draft"].count("Saved speech."), 2)
            finally:
                inbox.close()
                store.close()
            with self.assertRaises(sqlite3.ProgrammingError):
                list(runtime.transcripts.replay())
            runtime.stop()


if __name__ == "__main__":
    unittest.main()
