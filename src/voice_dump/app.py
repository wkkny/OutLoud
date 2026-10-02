import queue
import threading
import time

from .recording import Recorder
from .shortcuts import Controls, FnListener
from .transcription import transcription_worker


def recording_worker(events, recordings):
    recorder = Recorder()

    def stop_recording():
        recordings.put(recorder.stop())

    controls = Controls(recorder.start, stop_recording)
    try:
        while True:
            try:
                event = events.get(timeout=0.05)
            except queue.Empty:
                controls.tick(time.monotonic())
                continue
            if event is None:
                break
            pressed, timestamp = event
            controls.handle(pressed, timestamp)
    except Exception as error:
        print(f"Recording error: {error}. Restart the app to retry.", flush=True)
    finally:
        controls.stop()


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
