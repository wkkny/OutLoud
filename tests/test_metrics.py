import json
import queue
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from outloud.metrics import ResourceSampler, save_metrics
from outloud.transcription import TranscriptionJob, enqueue_recording, transcription_worker


def snapshot(available, rss, swap_out):
    return {
        "ram_available_bytes": available,
        "process_rss_bytes": rss,
        "swap_used_bytes": 10,
        "swap_out_bytes": swap_out,
    }


class MetricsTests(unittest.TestCase):
    def test_resource_summary_tracks_peaks_and_swap_delta(self):
        sampler = ResourceSampler()
        with patch("outloud.metrics.resource_snapshot", side_effect=[
            snapshot(100, 20, 5), snapshot(50, 40, 15), snapshot(90, 30, 15)
        ]):
            sampler.sample()
            sampler.sample()
            result = sampler.stop()
        self.assertEqual(result["sample_count"], 3)
        self.assertEqual(result["min_available_ram_bytes"], 50)
        self.assertEqual(result["peak_process_rss_bytes"], 40)
        self.assertEqual(result["swap_out_delta_bytes"], 10)

    def test_sampler_thread_stops_cleanly(self):
        sampler = ResourceSampler(interval=60)
        with patch("outloud.metrics.resource_snapshot", return_value=snapshot(100, 20, 5)):
            sampler.start()
            result = sampler.stop()
        self.assertFalse(sampler.thread.is_alive())
        self.assertEqual(result["sample_count"], 2)

    def test_resource_sampling_failure_does_not_raise(self):
        sampler = ResourceSampler()
        with patch("outloud.metrics.resource_snapshot", side_effect=RuntimeError("unavailable")):
            sampler.start()
            result = sampler.stop()
        self.assertEqual(result["sampling_error"], "unavailable")

    def test_metrics_write_failure_does_not_raise(self):
        with patch.object(Path, "write_text", side_effect=OSError("disk full")):
            save_metrics(Path("recordings/test"), {"status": "complete"})

    def test_enqueue_timestamps_job(self):
        jobs = queue.Queue()
        with patch("outloud.transcription.time.monotonic", return_value=123):
            enqueue_recording(jobs, Path("audio.wav"))
        self.assertEqual(jobs.get_nowait(), TranscriptionJob(Path("audio.wav"), 123))

    def run_transcription(self, folder, failure=False):
        path = folder / "audio.wav"
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x00\x00" * 32000)
        jobs = queue.Queue()
        jobs.put(TranscriptionJob(path, 2))
        jobs.put(None)
        with (
            patch("outloud.transcription.whisper.load_model") as load,
            patch("outloud.transcription.ResourceSampler") as sampler,
            patch("outloud.transcription.time.monotonic", side_effect=[5, 6, 8, 9, 10, 11]),
        ):
            sampler.return_value.stop.return_value = {"sample_count": 2}
            if failure:
                load.return_value.transcribe.side_effect = RuntimeError("model failed")
            else:
                load.return_value.transcribe.return_value = {"text": " Hello. "}
            transcription_worker(jobs)
            sampler.return_value.stop.assert_called_once()
        return json.loads((folder / "metrics.json").read_text())

    def test_transcription_saves_latency_and_resource_metrics(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            metrics = self.run_transcription(folder)
            self.assertEqual((folder / "transcript.txt").read_text(), "Hello.\n")
        self.assertEqual(metrics["status"], "complete")
        self.assertEqual(metrics["audio_seconds"], 2)
        self.assertEqual(metrics["queue_wait_seconds"], 3)
        self.assertEqual(metrics["model_load_seconds"], 2)
        self.assertEqual(metrics["transcription_seconds"], 1)
        self.assertEqual(metrics["save_to_transcript_seconds"], 9)
        self.assertEqual(metrics["real_time_factor"], .5)
        self.assertEqual(metrics["resources"], {"sample_count": 2})

    def test_transcription_failure_still_saves_metrics_and_audio(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            metrics = self.run_transcription(folder, failure=True)
            self.assertTrue((folder / "audio.wav").exists())
            self.assertFalse((folder / "transcript.txt").exists())
        self.assertEqual(metrics["status"], "failed")
        self.assertEqual(metrics["error"], "model failed")


if __name__ == "__main__":
    unittest.main()
