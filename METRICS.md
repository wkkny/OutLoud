# Measuring dictation performance

Run the app as usual:

```bash
uv run outloud
```

Each recording folder now contains `audio.wav`, `transcript.txt` (on success), and
`metrics.json`. The terminal prints a timing summary after every transcription.

## Latency

- `queue_wait_seconds`: time from enqueueing saved audio to starting its job.
- `model_load_seconds`: Whisper loading time; zero when the model is already loaded.
- `transcription_seconds`: time spent in Whisper's transcription call.
- `save_to_transcript_seconds`: queue wait, model loading, transcription, and saving
  the transcript. On failure, this is the time until failure handling completes.
  It does not include recording duration or the delay between key release and WAV saving.
- `audio_seconds`: duration read from the WAV header.
- `real_time_factor`: transcription time divided by audio duration. Below 1 means
  transcription is faster than real time. Interpret it alongside queue and load time.

Compare the first recording (cold model load) with later recordings separately.
Failed jobs also save timings and an error message.

## Resource indicators

During each job, resources are sampled every 0.5 seconds, plus at the start and end.
Metrics include minimum available host RAM, peak Python-process RSS, peak host swap
usage, and the increase in host swap-out bytes. Sampling can miss short-lived peaks;
these are sampled values, not guaranteed maxima.

For a separate live view of host RAM and swap, run:

```bash
uv run python -m outloud.metrics
```

Or take five samples:

```bash
uv run python -m outloud.metrics --interval 1 --count 5
```

These are **memory-pressure indicators**, not macOS's official Memory Pressure
classification. Use **Activity Monitor → Memory → Memory Pressure** for that.
Existing swap usage alone does not prove current pressure; watch available RAM,
new swap activity, the graph, and latency together. Swap counters may be unavailable
or zero on some systems.

Python RSS excludes Ollama's separate processes and does not represent all GPU or
unified-memory allocations. Host memory indicators do reflect system-wide demand,
including Ollama and other applications.

## Comparing with Gemma

Once Ollama is connected, compare similar recordings in these conditions:

1. Whisper alone, after the first model load.
2. Gemma loaded but idle.
3. Gemma actively generating while Whisper transcribes.

Record several runs per condition rather than drawing conclusions from one sample.
Ollama generation timing (first-token latency, total duration, and tokens per second)
will be added with the chat integration; it is not measured yet.
