import os
import queue
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from voice_dump.app import recording_worker
from voice_dump.recording import Recorder, RecordingError
from voice_dump.shortcuts import Controls


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.original_directory = Path.cwd()
        os.chdir(self.directory.name)
        self.stream = MagicMock()
        self.stream.active = True
        self.factory = patch(
            "voice_dump.recording.sd.RawInputStream", return_value=self.stream
        )
        self.create_stream = self.factory.start()
        self.recorder = Recorder()

    def tearDown(self):
        self.recorder.stop()
        self.factory.stop()
        os.chdir(self.original_directory)
        self.directory.cleanup()

    def capture(self):
        callback = self.create_stream.call_args.kwargs["callback"]
        callback(b"\x00\x00" * 160, 160, None, None)

    def test_creation_failure_removes_empty_attempt_and_allows_retry(self):
        self.create_stream.side_effect = RuntimeError("permission denied")
        with self.assertRaisesRegex(RecordingError, "permission denied"):
            self.recorder.start()
        self.assertIsNone(self.recorder.audio_file)
        self.assertEqual(list(Path("recordings").iterdir()), [])
        self.create_stream.side_effect = None
        self.recorder.start()
        self.capture()
        self.assertIsNotNone(self.recorder.stop())

    def test_start_failure_closes_stream_and_file(self):
        self.stream.start.side_effect = RuntimeError("device unavailable")
        with self.assertRaises(RecordingError):
            self.recorder.start()
        self.stream.close.assert_called_once()
        self.assertIsNone(self.recorder.audio_file)
        self.assertEqual(list(Path("recordings").iterdir()), [])

    def test_unexpected_stream_stop_preserves_playable_audio(self):
        self.recorder.start()
        self.capture()
        self.stream.active = False
        with self.assertRaisesRegex(RecordingError, "stopped unexpectedly"):
            self.recorder.check_health()
        path = self.recorder.stop()
        with wave.open(str(path)) as audio:
            self.assertEqual(audio.getnframes(), 160)
        self.assertIsNone(self.recorder.stop())

    def test_cleanup_errors_do_not_prevent_finalizing_audio_or_retry(self):
        self.recorder.start()
        self.capture()
        self.stream.stop.side_effect = RuntimeError("stop failed")
        self.stream.close.side_effect = RuntimeError("close failed")
        path = self.recorder.stop()
        self.stream.abort.assert_called_once()
        with wave.open(str(path)) as audio:
            self.assertEqual(audio.getnframes(), 160)
        self.assertIsNone(self.recorder.stream)
        self.assertIsNone(self.recorder.audio_file)
        self.recorder.start()
        self.capture()
        self.assertIsNotNone(self.recorder.stop())

    def test_failed_start_with_samples_preserves_audio(self):
        def fail_after_capture():
            self.capture()
            raise RuntimeError("device disconnected")

        self.stream.start.side_effect = fail_after_capture
        with self.assertRaises(RecordingError) as failure:
            self.recorder.start()
        with wave.open(str(failure.exception.saved_path)) as audio:
            self.assertEqual(audio.getnframes(), 160)

    def test_callback_failure_is_reported_to_worker(self):
        self.recorder.start()
        with patch.object(self.recorder.audio_file, "writeframesraw", side_effect=OSError("write failed")):
            import sounddevice as sd
            with self.assertRaises(sd.CallbackAbort):
                self.capture()
        with self.assertRaisesRegex(RecordingError, "write failed"):
            self.recorder.check_health()


class WorkerTests(unittest.TestCase):
    def run_worker(self, recorder, sequence):
        events = queue.Queue()
        recordings = queue.Queue()
        for event in sequence:
            events.put(event)
        events.put(None)
        with patch("voice_dump.app.Recorder", return_value=recorder):
            recording_worker(events, recordings)
        return list(recordings.queue)

    def test_start_failure_does_not_kill_worker_or_enqueue_empty_audio(self):
        recorder = MagicMock()
        recorder.start.side_effect = [RecordingError("permission denied"), None]
        recorder.stop.return_value = Path("saved.wav")
        jobs = self.run_worker(recorder, [(True, 0), (False, 1), (True, 2), (False, 3)])
        self.assertEqual(recorder.start.call_count, 2)
        recorder.stop.assert_called_once()
        self.assertEqual(jobs, [Path("saved.wav")])

    def test_hands_free_failure_resets_state_and_allows_next_hold(self):
        recorder = MagicMock()
        recorder.check_health.side_effect = [None, None, RecordingError("disconnected"), None, None]
        recorder.stop.side_effect = [Path("partial.wav"), Path("next.wav")]
        jobs = self.run_worker(
            recorder,
            [(True, 0), (False, .05), (True, .15), (False, .20), (True, 1), (False, 2)],
        )
        self.assertEqual(recorder.start.call_count, 2)
        self.assertEqual(jobs, [Path("partial.wav"), Path("next.wav")])

    def test_idle_poll_detects_disconnected_microphone_without_key_event(self):
        recorder = MagicMock()
        recorder.check_health.side_effect = RecordingError("disconnected")
        recorder.stop.return_value = Path("partial.wav")
        events = MagicMock()
        events.get.side_effect = [(True, 0), queue.Empty(), None]
        recordings = queue.Queue()
        with patch("voice_dump.app.Recorder", return_value=recorder):
            recording_worker(events, recordings)
        recorder.stop.assert_called_once()
        self.assertEqual(recordings.get_nowait(), Path("partial.wav"))

    def test_cleanup_exception_does_not_kill_worker(self):
        recorder = MagicMock()
        recorder.stop.side_effect = [RuntimeError("cleanup failed"), Path("next.wav")]
        jobs = self.run_worker(recorder, [(True, 0), (False, 1), (True, 2), (False, 3)])
        self.assertEqual(recorder.start.call_count, 2)
        self.assertEqual(jobs, [Path("next.wav")])

    def test_start_failure_queues_recovered_audio(self):
        recorder = MagicMock()
        recorder.start.side_effect = RecordingError("disconnected", Path("partial.wav"))
        jobs = self.run_worker(recorder, [(True, 0), (False, 1)])
        self.assertEqual(jobs, [Path("partial.wav")])

    def test_controls_reset_even_when_stop_raises(self):
        stop = MagicMock(side_effect=RuntimeError("cleanup failed"))
        controls = Controls(lambda: None, stop)
        controls.handle(True, 0)
        controls.handle(False, .05)
        controls.handle(True, .15)
        with self.assertRaises(RuntimeError):
            controls.stop()
        self.assertFalse(controls.recording)
        self.assertFalse(controls.hands_free)
        self.assertIsNone(controls.stop_at)
        controls.handle(False, .20)
        self.assertFalse(controls.recording)


if __name__ == "__main__":
    unittest.main()
