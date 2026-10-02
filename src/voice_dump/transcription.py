import time
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import whisper

from .metrics import ResourceSampler, save_metrics


@dataclass(frozen=True)
class TranscriptionJob:
    path: Path
    queued_at: float


def enqueue_recording(recordings, path):
    recordings.put(TranscriptionJob(path, time.monotonic()))


def transcription_worker(recordings):
    model = None
    while True:
        job = recordings.get()
        if job is None:
            return
        path = job.path
        started = time.monotonic()
        metrics = {
            "recording_id": path.parent.name,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "model": "base",
            "queue_wait_seconds": max(0, started - job.queued_at),
            "model_load_seconds": 0,
            "status": "failed",
        }
        sampler = ResourceSampler()
        sampler.start()
        try:
            with wave.open(str(path), "rb") as audio:
                metrics["audio_seconds"] = audio.getnframes() / audio.getframerate()
            if model is None:
                print("Loading Whisper base model...", flush=True)
                load_started = time.monotonic()
                try:
                    model = whisper.load_model("base")
                finally:
                    metrics["model_load_seconds"] = time.monotonic() - load_started
            print(f"Transcribing: {path}", flush=True)
            transcribe_started = time.monotonic()
            try:
                result = model.transcribe(str(path), fp16=False)
            finally:
                metrics["transcription_seconds"] = time.monotonic() - transcribe_started
            text = result["text"].strip()
            transcript_path = path.parent / "transcript.txt"
            transcript_path.write_text(text + "\n", encoding="utf-8")
            metrics["status"] = "complete"
            print(f"\nTranscript ({path.parent.name}):\n{text}\n", flush=True)
            print(f"Transcript saved: {transcript_path}", flush=True)
        except Exception as error:
            metrics["error"] = str(error)
            print(
                f"Transcription failed for {path}: {error}. Audio is still saved.",
                flush=True,
            )
        finally:
            metrics["save_to_transcript_seconds"] = time.monotonic() - job.queued_at
            audio_seconds = metrics.get("audio_seconds", 0)
            if audio_seconds > 0 and "transcription_seconds" in metrics:
                metrics["real_time_factor"] = metrics["transcription_seconds"] / audio_seconds
            metrics["resources"] = sampler.stop()
            save_metrics(path.parent, metrics)
            print(
                f"Metrics: queue {metrics['queue_wait_seconds']:.2f}s | "
                f"model load {metrics['model_load_seconds']:.2f}s | "
                f"transcription {metrics.get('transcription_seconds', 0):.2f}s | "
                f"save-to-result {metrics['save_to_transcript_seconds']:.2f}s",
                flush=True,
            )
