import uuid
import wave
from datetime import datetime
from pathlib import Path

import sounddevice as sd

SAMPLE_RATE = 16000


class Recorder:
    def start(self):
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
            # Write each block instead of keeping the entire recording in memory.
            self.audio_file.writeframesraw(bytes(data))

        self.stream = None
        try:
            self.stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="int16",
                callback=capture,
            )
            self.stream.start()
        except Exception:
            if self.stream is not None:
                self.stream.close()
            self.audio_file.close()
            raise
        print("Recording...", flush=True)

    def stop(self):
        try:
            self.stream.stop()
        finally:
            self.stream.close()
            self.audio_file.close()
        print(f"Saved: {self.path}", flush=True)
        return self.path
