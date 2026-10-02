import queue
import threading
import time

from .recording import Recorder
from .shortcuts import Controls, FnListener
from .transcription import transcription_worker


def recording_worker(events, recordings):
    recorder = Recorder()

    def stop_recording():
        path = recorder.stop()
        if path is not None:
            recordings.put(path)

    controls = Controls(recorder.start, stop_recording)

    def recover(error):
        try:
            controls.stop()
        except Exception as cleanup_error:
            print(f"Recording cleanup error: {cleanup_error}", flush=True)
        saved_path = getattr(error, "saved_path", None)
        if saved_path is not None:
            recordings.put(saved_path)
        print(
            f"Recording failed: {error}. Check your microphone or permissions, "
            "then press Fn again to retry.",
            flush=True,
        )

    try:
        while True:
            try:
                event = events.get(timeout=0.05)
            except queue.Empty:
                event = "tick"
            if event is None:
                break
            try:
                if controls.recording:
                    recorder.check_health()
                if event == "tick":
                    controls.tick(time.monotonic())
                else:
                    pressed, timestamp = event
                    controls.handle(pressed, timestamp)
            except Exception as error:
                recover(error)
    finally:
        try:
            controls.stop()
        except Exception as error:
            recover(error)


def main():
    events = queue.Queue()
    recordings = queue.Queue()
    listener = FnListener(events)
    listener.start()

    transcriber = threading.Thread(target=transcription_worker, args=(recordings,))
    worker = threading.Thread(target=recording_worker, args=(events, recordings))
    transcriber.start()
    worker.start()

    print("Hold Fn to record. Double-tap for hands-free. Ctrl+C to quit.", flush=True)
    try:
        listener.run()
    except KeyboardInterrupt:
        pass
    finally:
        listener.stop()
        events.put(None)
        worker.join()
        # Finish all saved recordings before the transcription worker exits.
        recordings.put(None)
        print("Finishing queued transcriptions before exiting...", flush=True)
        transcriber.join()


if __name__ == "__main__":
    main()
