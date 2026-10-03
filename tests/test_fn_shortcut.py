import json
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

if sys.platform == "darwin":
    import Quartz
    from CoreFoundation import kCFRunLoopRunFinished, kCFRunLoopRunStopped
else:
    Quartz = None

from outloud.runtime import RecordingRuntime
from outloud.server import create_app
from outloud.shortcuts import FnListener
from test_server import FakeRecorder, LocalTestClient, ORIGIN, receive_type


class FakeFnListener:
    def __init__(self, factory, on_key, on_failure):
        self.factory = factory
        self.on_key = on_key
        self.on_failure = on_failure
        self.stopped = threading.Event()
        self.closed = threading.Event()

    def start(self):
        if not self.factory.start_gate.wait(5):
            raise RuntimeError("test capture startup timed out")
        if self.factory.failure:
            raise self.factory.failure

    def run(self):
        self.stopped.wait()
        if self.factory.run_failure is not None:
            raise self.factory.run_failure

    def stop(self):
        self.stopped.set()

    def close(self):
        self.closed.set()


class FakeFnFactory:
    def __init__(self):
        self.instances = []
        self.failure = None
        self.run_failure = None
        self.start_gate = threading.Event()
        self.start_gate.set()

    def __call__(self, on_key, on_failure):
        listener = FakeFnListener(self, on_key, on_failure)
        self.instances.append(listener)
        return listener


class FnShortcutTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.recorder = FakeRecorder(Path(self.directory.name))
        self.factory = FakeFnFactory()
        self.model_patch = patch("outloud.transcription.whisper.load_model")
        self.model_patch.start().return_value.transcribe.return_value = {"text": "Fn transcript"}
        app = create_app(lambda publish: RecordingRuntime(
            publish, self.recorder, fn_listener_factory=self.factory,
        ))
        self.client = LocalTestClient(app, base_url="http://127.0.0.1:8765")
        self.client.__enter__()
        self.runtime = app.state.runtime

    def tearDown(self):
        self.factory.start_gate.set()
        self.client.__exit__(None, None, None)
        self.assertTrue(all(listener.closed.is_set() for listener in self.factory.instances))
        self.model_patch.stop()
        self.directory.cleanup()

    def wait_state(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.client.get("/state").json()
            if predicate(state):
                return state
            time.sleep(0.005)
        self.fail(f"State did not converge: {state}")

    def headers(self, websocket):
        return {**ORIGIN, "X-Session-ID": receive_type(websocket, "session.ready")["session_id"]}

    def configure(self, headers, enabled=True, conversation_id="fn-chat"):
        return self.client.post("/shortcuts/fn", headers=headers, json={
            "enabled": enabled, "conversation_id": conversation_id,
        })

    def enable(self, headers):
        self.assertEqual(self.configure(headers).status_code, 202)
        self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
        return self.factory.instances[-1]

    def test_unsupported_fn_shortcut_does_not_block_backend(self):
        class UnsupportedFactory(FakeFnFactory):
            @staticmethod
            def availability_error():
                return "Fn/Globe capture is unavailable in this test."

        self.runtime.fn_shortcut.listener_factory = UnsupportedFactory()
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            self.assertEqual(self.configure(headers).status_code, 202)
            state = self.client.get("/state").json()
            self.assertEqual(state["fn_shortcut"], {
                "status": "failed",
                "error": "Fn/Globe capture is unavailable in this test.",
            })
            self.assertEqual(self.client.get("/ready").status_code, 200)

    def drain(self, recording):
        return self.wait_state(lambda state: state["pending_commands"] == 0 and state["recording"] == recording)

    def test_off_by_default_and_requires_owner_valid_body_and_trusted_origin(self):
        self.assertEqual(self.client.get("/state").json()["fn_shortcut"], {"status": "disabled", "error": None})
        self.assertEqual(self.configure(ORIGIN).status_code, 403)
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            self.assertEqual(self.factory.instances, [])
            self.assertEqual(self.configure({**headers, "X-Session-ID": "wrong"}).status_code, 403)
            self.assertEqual(self.configure({**headers, "Origin": "https://unrelated.example"}).status_code, 403)
            self.assertEqual(self.client.post("/shortcuts/fn", headers=headers, json={"enabled": True}).status_code, 422)
            self.assertEqual(self.configure(headers, enabled="yes").status_code, 422)
            self.assertEqual(self.configure(headers, conversation_id="").status_code, 422)
            self.assertEqual(self.factory.instances, [])

    def test_hold_uses_shared_worker_context_and_transcript_delivery(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            now = time.monotonic()
            self.assertTrue(capture.on_key(True, now))
            state = self.drain(True)
            self.assertEqual(state["mode"], "hold")
            self.assertEqual(state["conversation_id"], "fn-chat")
            self.assertNotIn(self.runtime.owner_session_id, json.dumps(state))
            self.assertTrue(capture.on_key(False, now + 0.4))
            self.drain(False)
            transcript = receive_type(websocket, "transcription.completed")
            self.assertEqual(transcript["conversation_id"], "fn-chat")
            self.assertEqual(transcript["text"], "Fn transcript")
            self.assertNotIn("session_id", transcript)
            self.assertEqual(self.recorder.starts, 1)

    def test_double_tap_is_one_hands_free_recording_and_next_tap_stops(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            now = time.monotonic()
            for pressed, offset in ((True, 0), (False, 0.04), (True, 0.08), (False, 0.12)):
                self.assertTrue(capture.on_key(pressed, now + offset))
            state = self.drain(True)
            self.assertTrue(state["hands_free"])
            self.assertEqual(self.recorder.starts, 1)
            capture.on_key(True, now + 0.5)
            capture.on_key(False, now + 0.6)
            self.drain(False)
            self.assertEqual(self.recorder.starts, 1)

    def test_overlapping_ui_and_fn_holds_do_not_release_each_other_or_restart_audio(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            now = time.monotonic()
            capture.on_key(True, now)
            self.drain(True)
            self.client.post("/recording/press", headers=headers, json={"conversation_id": "different-chat"})
            capture.on_key(False, now + 0.4)
            state = self.drain(True)
            self.assertEqual(state["conversation_id"], "fn-chat")
            self.assertEqual(self.recorder.starts, 1)
            self.client.post("/recording/stop", headers=headers)
            self.drain(False)

    def test_fn_press_stops_ui_hands_free_while_second_ui_press_is_still_held(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            for action in ("press", "release", "press"):
                self.client.post(f"/recording/{action}", headers=headers, json={"conversation_id": "ui-chat"})
            state = self.drain(True)
            self.assertTrue(state["hands_free"])
            self.assertTrue(capture.on_key(True, time.monotonic()))
            self.drain(False)
            self.assertEqual(self.recorder.starts, 1)
            # Releases from either old hold cannot restart the stopped recording.
            self.client.post("/recording/release", headers=headers)
            capture.on_key(False, time.monotonic())
            self.drain(False)

    def test_ui_press_stops_fn_hands_free_even_before_fn_second_tap_is_released(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            now = time.monotonic()
            for pressed, offset in ((True, 0), (False, 0.04), (True, 0.08)):
                capture.on_key(pressed, now + offset)
            self.assertTrue(self.drain(True)["hands_free"])
            for _ in range(2):  # A repeated stop press must not restart audio.
                self.client.post("/recording/press", headers=headers, json={"conversation_id": "ui-chat"})
            self.drain(False)
            capture.on_key(False, now + 0.12)
            self.client.post("/recording/release", headers=headers)
            self.drain(False)
            self.assertEqual(self.recorder.starts, 1)
            capture.on_key(True, now + 0.5)
            self.drain(True)
            self.assertEqual(self.recorder.starts, 2)

    def test_disable_during_microphone_startup_blocks_keys_and_drains_the_late_start(self):
        starting = threading.Event()
        finish = threading.Event()
        original_start = self.recorder.start

        def delayed_start():
            starting.set()
            if not finish.wait(3):
                raise RuntimeError("test microphone start timed out")
            original_start()

        try:
            with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
                headers = self.headers(websocket)
                capture = self.enable(headers)
                with patch.object(self.recorder, "start", side_effect=delayed_start):
                    capture.on_key(True, time.monotonic())
                    self.assertTrue(starting.wait(3))
                    self.assertEqual(self.configure(headers, False).status_code, 202)
                    state = self.client.get("/state").json()
                    self.assertEqual(state["fn_shortcut"]["status"], "disabled")
                    self.assertEqual(state["pending_commands"], 2)
                    self.assertFalse(state["recording"])
                    self.assertFalse(capture.on_key(True, time.monotonic()))
                    self.assertTrue(capture.closed.wait(3))
                    finish.set()
                    self.drain(False)
                    self.assertEqual(self.recorder.starts, 1)
        finally:
            finish.set()

    def test_ui_stop_and_late_fn_release_do_not_restart_recording(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            now = time.monotonic()
            capture.on_key(True, now)
            self.drain(True)
            self.client.post("/recording/stop", headers=headers)
            self.drain(False)
            capture.on_key(False, now + 0.4)
            self.drain(False)
            self.assertEqual(self.recorder.starts, 1)

    def test_disable_stops_recording_releases_capture_and_rejects_late_callbacks(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            capture.on_key(True, time.monotonic())
            self.drain(True)
            self.assertEqual(self.configure(headers, False).status_code, 202)
            state = self.drain(False)
            self.assertEqual(state["fn_shortcut"]["status"], "disabled")
            self.assertFalse(capture.on_key(True, time.monotonic()))
            self.assertTrue(capture.closed.wait(3))
            self.assertEqual(self.recorder.starts, 1)

    def test_disconnect_stops_capture_and_new_owner_must_opt_in_again(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            capture.on_key(True, time.monotonic())
            self.drain(True)
        self.drain(False)
        self.assertTrue(capture.closed.wait(3))
        self.assertFalse(capture.on_key(True, time.monotonic()))
        self.assertEqual(self.configure(headers).status_code, 403)
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            ready = receive_type(websocket, "session.ready")
            self.assertEqual(ready["state"]["fn_shortcut"]["status"], "disabled")
            new_capture = self.enable({**ORIGIN, "X-Session-ID": ready["session_id"]})
            self.assertFalse(capture.on_key(True, time.monotonic()))
            self.assertTrue(new_capture.on_key(True, time.monotonic()))
            self.drain(True)
            self.assertEqual(self.recorder.starts, 2)

    def test_permission_failure_is_optional_safe_and_retryable(self):
        self.factory.failure = PermissionError("denied at /private/permissions")
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            self.assertEqual(self.configure(headers).status_code, 202)
            state = self.wait_state(lambda state: state["fn_shortcut"]["status"] == "failed")
            self.assertIn("Accessibility", state["fn_shortcut"]["error"])
            self.assertNotIn("/private/permissions", json.dumps(state))
            self.assertTrue(state["ready"])
            self.assertFalse(self.factory.instances[-1].on_key(True, time.monotonic()))
            self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "ui-chat"})
            self.drain(True)
            self.client.post("/recording/stop", headers=headers)
            self.drain(False)
            self.factory.failure = None
            self.enable(headers)

    def test_permission_failure_does_not_interrupt_an_existing_ui_recording(self):
        self.factory.failure = PermissionError("denied")
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            self.client.post("/recording/hands-free", headers=headers, json={"conversation_id": "ui-chat"})
            self.drain(True)
            self.configure(headers)
            state = self.wait_state(lambda state: state["fn_shortcut"]["status"] == "failed")
            self.assertTrue(state["recording"])
            self.assertEqual(state["conversation_id"], "ui-chat")

    def test_thread_start_failure_is_optional_and_shutdown_still_works(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            with patch("outloud.fn_shortcut.threading.Thread.start", side_effect=RuntimeError("no threads")):
                self.assertEqual(self.configure(headers).status_code, 202)
            state = self.client.get("/state").json()
            self.assertEqual(state["fn_shortcut"]["status"], "failed")
            self.assertTrue(state["ready"])
            self.assertEqual(self.factory.instances, [])

    def test_unexpected_capture_exit_stops_recording_and_releases_native_resources(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            capture.on_key(True, time.monotonic())
            self.drain(True)
            capture.stop()
            state = self.wait_state(lambda state: state["fn_shortcut"]["status"] == "failed" and not state["recording"] and state["pending_commands"] == 0)
            self.assertIn("exited unexpectedly", state["fn_shortcut"]["error"])
            self.assertTrue(state["ready"])
            self.assertTrue(capture.closed.wait(3))

    def test_system_exit_in_capture_thread_cannot_leave_recording_active(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            capture.on_key(True, time.monotonic())
            self.drain(True)
            self.factory.run_failure = SystemExit(1)
            capture.stop()
            state = self.wait_state(lambda state: state["fn_shortcut"]["status"] == "failed" and not state["recording"] and state["pending_commands"] == 0)
            self.assertTrue(state["ready"])
            self.assertFalse(capture.on_key(False, time.monotonic()))
            self.assertTrue(capture.closed.wait(3))

    def test_cancel_and_reenable_during_startup_ignores_old_capture(self):
        self.factory.start_gate.clear()
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            self.configure(headers)
            deadline = time.monotonic() + 3
            while not self.factory.instances and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertEqual(len(self.factory.instances), 1)
            old = self.factory.instances[0]
            self.assertEqual(self.client.get("/state").json()["fn_shortcut"]["status"], "starting")
            self.assertFalse(old.on_key(True, time.monotonic()))
            self.configure(headers, False)
            self.configure(headers)
            self.factory.start_gate.set()
            self.wait_state(lambda state: state["fn_shortcut"]["status"] == "enabled")
            self.assertTrue(old.closed.wait(3))
            self.assertFalse(old.on_key(True, time.monotonic()))
            self.factory.instances[-1].on_key(True, time.monotonic())
            self.drain(True)
            old.on_failure("stale failure")
            self.assertFalse(old.on_key(False, time.monotonic()))
            state = self.drain(True)
            self.assertEqual(state["fn_shortcut"], {"status": "enabled", "error": None})

    def test_native_capture_loss_stops_recording_without_failing_readiness(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            capture.on_key(True, time.monotonic())
            self.drain(True)
            capture.on_failure("macOS paused Fn capture")
            state = self.drain(False)
            self.assertEqual(state["fn_shortcut"], {"status": "failed", "error": "macOS paused Fn capture"})
            self.assertTrue(state["ready"])
            self.assertFalse(capture.on_key(False, time.monotonic()))
            self.assertTrue(capture.closed.wait(3))

    def test_worker_unavailability_stops_interception_and_recording(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            capture = self.enable(self.headers(websocket))
            capture.on_key(True, time.monotonic())
            self.drain(True)
            with patch.object(self.runtime, "worker_running", side_effect=lambda name: name == "recording"):
                self.assertFalse(capture.on_key(False, time.monotonic()))
            state = self.drain(False)
            self.assertEqual(state["fn_shortcut"]["status"], "failed")
            self.assertTrue(capture.closed.wait(3))

    def test_repeated_enable_is_idempotent_and_shutdown_closes_capture(self):
        with self.client.websocket_connect("/events", headers=ORIGIN) as websocket:
            headers = self.headers(websocket)
            capture = self.enable(headers)
            self.configure(headers)
            self.assertEqual(len(self.factory.instances), 1)
            self.runtime.stop()
            self.assertTrue(capture.closed.is_set())
            self.assertFalse(capture.on_key(True, time.monotonic()))
            self.assertEqual(self.client.get("/state").json()["fn_shortcut"]["status"], "disabled")


@unittest.skipUnless(sys.platform == "darwin", "Fn event tap is macOS-only")
class FnListenerTests(unittest.TestCase):
    def setUp(self):
        self.key = Mock(return_value=True)
        self.failure = Mock()
        self.listener = FnListener(self.key, self.failure)
        self.event = object()
        self.keycode_patch = patch("outloud.shortcuts.Quartz.CGEventGetIntegerValueField", return_value=63)
        self.flags_patch = patch("outloud.shortcuts.Quartz.CGEventGetFlags", return_value=Quartz.kCGEventFlagMaskSecondaryFn)
        self.keycode = self.keycode_patch.start()
        self.flags = self.flags_patch.start()
        self.addCleanup(self.keycode_patch.stop)
        self.addCleanup(self.flags_patch.stop)

    def event_callback(self):
        return self.listener.on_event(None, Quartz.kCGEventFlagsChanged, self.event, None)

    def test_only_claimed_fn_edges_are_suppressed(self):
        self.assertIsNone(self.event_callback())
        self.flags.return_value = 0
        self.assertIsNone(self.event_callback())
        self.assertEqual([call.args[0] for call in self.key.call_args_list], [True, False])
        self.key.return_value = False
        self.flags.return_value = Quartz.kCGEventFlagMaskSecondaryFn
        self.assertIs(self.event_callback(), self.event)
        self.flags.return_value = 0
        self.assertIs(self.event_callback(), self.event)
        self.assertEqual(self.key.call_count, 3)

    def test_other_modifiers_and_duplicate_flags_do_not_emit_or_get_swallowed(self):
        self.keycode.return_value = 56  # Shift, with Fn held.
        self.assertIs(self.event_callback(), self.event)
        self.key.assert_not_called()
        self.keycode.return_value = 63
        self.assertIsNone(self.event_callback())
        self.assertIsNone(self.event_callback())
        self.assertEqual(self.key.call_count, 1)

    def test_stopped_listener_passes_events_through(self):
        self.listener.stop()
        self.assertIs(self.event_callback(), self.event)
        self.key.assert_not_called()

    def test_tap_disabled_reports_loss_and_does_not_silently_reenable(self):
        for event_type in (Quartz.kCGEventTapDisabledByTimeout, Quartz.kCGEventTapDisabledByUserInput):
            listener = FnListener(self.key, self.failure)
            with patch("outloud.shortcuts.Quartz.CGEventTapEnable") as enable:
                self.assertIs(listener.on_event(None, event_type, self.event, None), self.event)
                self.assertTrue(listener.stopped.is_set())
                enable.assert_not_called()
        self.assertEqual(self.failure.call_count, 2)

    def test_enabling_while_fn_is_held_requires_a_fresh_press(self):
        with patch("outloud.shortcuts.Quartz.CGEventSourceFlagsState", return_value=Quartz.kCGEventFlagMaskSecondaryFn), \
             patch("outloud.shortcuts.Quartz.CGEventTapCreate", return_value=None):
            with self.assertRaises(PermissionError):
                self.listener.start()
        self.flags.return_value = 0
        self.assertIs(self.event_callback(), self.event)
        self.key.assert_not_called()
        self.flags.return_value = Quartz.kCGEventFlagMaskSecondaryFn
        self.assertIsNone(self.event_callback())

    def test_missing_native_source_or_stopped_loop_exits_instead_of_spinning(self):
        for result in (kCFRunLoopRunFinished, kCFRunLoopRunStopped):
            with self.subTest(result=result), patch(
                "outloud.shortcuts.CFRunLoopRunInMode",
                side_effect=[result, AssertionError("Retried a terminated run loop")],
            ):
                self.listener.run()

    def test_stop_before_start_never_creates_a_native_tap(self):
        self.listener.stop()
        with patch("outloud.shortcuts.Quartz.CGEventTapCreate") as create:
            self.listener.start()
            create.assert_not_called()
        self.listener.run()
        self.listener.close()

    def test_native_disable_failure_still_invalidates_tap(self):
        tap = object()
        self.listener.tap = tap
        with patch("outloud.shortcuts.Quartz.CGEventTapEnable", side_effect=RuntimeError("disable failed")), \
             patch("outloud.shortcuts.Quartz.CFMachPortInvalidate") as invalidate:
            with self.assertRaises(RuntimeError):
                self.listener.close()
            invalidate.assert_called_once_with(tap)
        self.listener.close()

    def test_partial_start_failure_and_repeated_close_clean_up_native_tap(self):
        tap = object()
        with patch("outloud.shortcuts.Quartz.CGEventSourceFlagsState", return_value=0), \
             patch("outloud.shortcuts.Quartz.CGEventTapCreate", return_value=tap), \
             patch("outloud.shortcuts.CFMachPortCreateRunLoopSource", return_value=None), \
             patch("outloud.shortcuts.Quartz.CGEventTapEnable") as enable, \
             patch("outloud.shortcuts.Quartz.CFMachPortInvalidate") as invalidate:
            with self.assertRaises(RuntimeError):
                self.listener.start()
            self.listener.close()
            self.listener.close()
            enable.assert_called_once_with(tap, False)
            invalidate.assert_called_once_with(tap)


if __name__ == "__main__":
    unittest.main()
