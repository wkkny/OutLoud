import sounddevice as sd
from scipy.io.wavfile import write
import whisper


sample_rate = 16000
duration = 5

input("Press Enter to record for 5 seconds...")
print("Recording")


audio = sd.rec(
    int(duration*sample_rate),
    samplerate=sample_rate,
    channels=1,
    dtype="float32",
)

sd.wait()

write("recording.wav", sample_rate, audio)
print("Recording Saved. Transcribing...")

model = whisper.load_model("base")
result = model.transcribe("recording.wav", fp16=False)

print("\nTranscript: ")
print(result["text"].strip())