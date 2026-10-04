import uuid
import wave
import math
import threading
from array import array
from datetime import datetime
from pathlib import Path

import sounddevice as sd

SAMPLE_RATE = 16000


def is_valid_level(level):
    return (isinstance(level, (int, float)) and not isinstance(level, bool)
            and 0 <= level <= 1 and math.isfinite(level))


class RecordingError(RuntimeError):
    def __init__(self, message, saved_path=None):
        super().__init__(message)
        self.saved_path = saved_path


class Recorder:
    def __init__(self):
        self.stream = None
        self.audio_file = None
        self.path = None
        self.frames = 0
        self.callback_error = None
        self.level_lock = threading.Lock()
        self.level = 0.0

    def read_level(self):
        """Return the highest block RMS since the previous read, then clear it."""
        with self.level_lock:
            level = self.level
            self.level = 0.0
        return level

    def start(self):
        self.frames = 0
        self.callback_error = None
        self.read_level()
        try:
            name = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            folder = Path("recordings") / f"{name}_{uuid.uuid4().hex[:8]}"
            folder.mkdir(parents=True)
            self.path = folder / "audio.wav"
            self.audio_file = wave.open(str(self.path), "wb")
            self.audio_file.setnchannels(1)
            self.audio_file.setsampwidth(2)
            self.audio_file.setframerate(SAMPLE_RATE)

            def capture(data, frames, timing, status):
                if status:
                    print(f"Audio warning: {status}", flush=True)
                try:
                    pcm = bytes(data)
                    self.audio_file.writeframesraw(pcm)
                    self.frames += frames
                    samples = array("h", pcm)
                    if samples:
                        # Python integers avoid overflow when squaring int16 PCM.
                        level = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768.0
                        with self.level_lock:
                            self.level = max(self.level, level)
                except Exception as error:
                    self.callback_error = error
                    raise sd.CallbackAbort from error

            self.stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="int16",
                callback=capture,
            )
            self.stream.start()
        except Exception as error:
            saved_path = self.stop()
            raise RecordingError(str(error), saved_path) from error
        print("Recording...", flush=True)

    def check_health(self):
        if self.callback_error is not None:
            raise RecordingError(f"Audio capture failed: {self.callback_error}")
        if self.stream is None or not self.stream.active:
            raise RecordingError("The microphone stream stopped unexpectedly")

    def stop(self):
        stream = self.stream
        audio_file = self.audio_file
        path = self.path
        if stream is None and audio_file is None and path is None:
            return None

        # Always attempt every cleanup step, even if one of them fails.
        if stream is not None:
            try:
                stream.stop()
            except Exception as error:
                print(f"Could not stop microphone: {error}", flush=True)
                try:
                    stream.abort()
                except Exception as abort_error:
                    print(f"Could not abort microphone: {abort_error}", flush=True)
            try:
                stream.close()
            except Exception as error:
                print(f"Could not close microphone: {error}", flush=True)

        finalized = False
        if audio_file is not None:
            try:
                audio_file.close()
                finalized = True
            except Exception as error:
                print(f"Could not finalize audio at {path}: {error}", flush=True)

        self.stream = None
        self.audio_file = None
        self.path = None
        self.read_level()
        if path is not None and self.frames > 0 and finalized:
            print(f"Saved: {path}", flush=True)
            return path
        if path is not None and self.frames == 0:
            try:
                path.unlink(missing_ok=True)
                path.parent.rmdir()
            except OSError as error:
                print(f"Could not remove empty recording: {error}", flush=True)
        return None
