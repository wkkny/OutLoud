import whisper


def transcription_worker(recordings):
    model = None
    while True:
        path = recordings.get()
        if path is None:
            return
        try:
            if model is None:
                print("Loading Whisper base model...", flush=True)
                model = whisper.load_model("base")
            print(f"Transcribing: {path}", flush=True)
            result = model.transcribe(str(path), fp16=False)
            text = result["text"].strip()
            transcript_path = path.parent / "transcript.txt"
            transcript_path.write_text(text + "\n", encoding="utf-8")
            print(f"\nTranscript ({path.parent.name}):\n{text}\n", flush=True)
            print(f"Transcript saved: {transcript_path}", flush=True)
        except Exception as error:
            print(
                f"Transcription failed for {path}: {error}. Audio is still saved.",
                flush=True,
            )
