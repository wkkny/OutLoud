import os
import queue
import struct
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from outloud.app import recording_worker
from outloud.recording import Recorder, RecordingError
from outloud.shortcuts import Controls


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.original_directory = Path.cwd()
        os.chdir(self.directory.name)
        self.stream = MagicMock()
        self.stream.active = True
        self.factory = patch(
            "outloud.recording.sd.RawInputStream", return_value=self.stream
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

    def test_level_measures_rms_of_captured_pcm_and_preserves_audio(self):
        self.recorder.start()
        callback = self.create_stream.call_args.kwargs["callback"]
        pcm = struct.pack("4h", 0, 0, 16384, -16384)
        callback(pcm, 4, None, None)
        self.assertAlmostEqual(self.recorder.read_level(), 0.3535533905932738)
        with wave.open(str(self.recorder.stop())) as audio:
            self.assertEqual(audio.readframes(4), pcm)

    def test_level_retains_peak_since_read_and_resets_between_recordings(self):
        self.assertEqual(self.recorder.read_level(), 0.0)
        self.recorder.start()
        callback = self.create_stream.call_args.kwargs["callback"]
        callback(struct.pack("2h", -32768, -32768), 2, None, None)
        self.capture()
        self.assertEqual(self.recorder.read_level(), 1.0)
        self.assertEqual(self.recorder.read_level(), 0.0)
        callback(struct.pack("2h", 16384, -16384), 2, None, None)
        self.recorder.stop()
        self.assertEqual(self.recorder.read_level(), 0.0)
        self.recorder.start()
        self.assertEqual(self.recorder.read_level(), 0.0)
        self.capture()
        callback(b"", 0, None, None)
        self.assertEqual(self.recorder.read_level(), 0.0)

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
    def test_worker_drops_invalid_levels_without_interrupting_capture(self):
        for level in (float("nan"), float("inf"), -0.1, 1.1, True, "0.5", None):
            with self.subTest(level=level):
                recorder = MagicMock()
                recorder.path = Path("recording-one/audio.wav")
                recorder.stop.return_value = None
                recorder.read_level.return_value = level
                events = queue.Queue()
                events.put({"action": "hands-free", "timestamp": 0,
                            "session_id": "owner", "conversation_id": "chat"})
                events.put(None)
                published = []
                recording_worker(events, queue.Queue(), published.append, recorder)
                self.assertFalse(any(event["type"] == "recording.level" for event in published))
                self.assertFalse(published[-1]["recording"])

    def test_worker_samples_levels_at_bounded_cadence_only_while_recording(self):
        recorder = MagicMock()
        recorder.path = Path("recording-one/audio.wav")
        recorder.stop.return_value = None
        recorder.read_level.side_effect = [0.25, 0.5, 0.75]
        start = {"action": "hands-free", "timestamp": 0.01,
                 "session_id": "owner", "conversation_id": "chat"}
        stop = {**start, "action": "stop", "timestamp": 0.14}
        sequence = iter([(0, "tick"), (0.01, start), (0.02, start),
                         (0.03, "tick"), (0.07, "tick"), (0.13, "tick"),
                         (0.14, stop), (0.20, "tick"), (0.30, None)])
        now = 0

        def next_event(**kwargs):
            nonlocal now
            now, event = next(sequence)
            return event

        events = MagicMock()
        events.get.side_effect = next_event
        published = []
        with patch("outloud.app.time.monotonic", side_effect=lambda: now):
            recording_worker(events, queue.Queue(), published.append, recorder)
        self.assertEqual([event for event in published if event["type"] == "recording.level"], [
            {"type": "recording.level", "recording_id": "recording-one", "session_id": "owner", "level": level}
            for level in (0.25, 0.5, 0.75)
        ])

    def run_worker(self, recorder, sequence):
        events = queue.Queue()
        recordings = queue.Queue()
        for event in sequence:
            events.put(event)
        events.put(None)
        with patch("outloud.app.Recorder", return_value=recorder):
            recording_worker(events, recordings)
        return [job.path for job in recordings.queue]

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
        with patch("outloud.app.Recorder", return_value=recorder):
            recording_worker(events, recordings)
        recorder.stop.assert_called_once()
        self.assertEqual(recordings.get_nowait().path, Path("partial.wav"))

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
