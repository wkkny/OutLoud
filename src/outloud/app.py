import queue
import time

from .recording import Recorder
from .shortcuts import Controls
from .transcription import enqueue_recording


def recording_worker(events, recordings, on_event=None, recorder=None):
    recorder = recorder if recorder is not None else Recorder()
    context = {"conversation_id": None, "session_id": None}
    last_state = None
    pressed = False
    recording_id = None

    def notify(event):
        if on_event is not None:
            on_event(event)

    def save_recording(path):
        if path is not None:
            notify({"type": "recording.saved", "recording_id": path.parent.name, **context})
            enqueue_recording(recordings, path, **context, on_event=notify)

    def start_recording():
        nonlocal recording_id
        recorder.start()
        recording_id = recorder.path.parent.name

    def stop_recording():
        nonlocal recording_id
        try:
            save_recording(recorder.stop())
        finally:
            recording_id = None

    controls = Controls(start_recording, stop_recording)

    def publish_state():
        nonlocal last_state
        state = {
            **context,
            "recording": controls.recording,
            "hands_free": controls.hands_free,
            "recording_id": recording_id,
            "conversation_id": context["conversation_id"] if controls.recording else None,
        }
        if state != last_state:
            last_state = state
            notify({"type": "recording.state", **state})

    def recover(error):
        failed_recording_id = recording_id
        try:
            controls.stop()
        except Exception as cleanup_error:
            print(f"Recording cleanup error: {cleanup_error}", flush=True)
        save_recording(getattr(error, "saved_path", None))
        message = f"Recording failed: {error}. Check your microphone or permissions and retry."
        print(message, flush=True)
        notify({
            "type": "recording.error",
            "message": message,
            "recording_id": failed_recording_id,
            **context,
        })

    publish_state()
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
                elif isinstance(event, dict):
                    action = event["action"]
                    if action == "stop":
                        pressed = False
                        controls.stop()
                    elif action == "hands-free":
                        pressed = False
                        controls.tick(event["timestamp"])
                        if not controls.recording:
                            context = {
                                "conversation_id": event["conversation_id"],
                                "session_id": event["session_id"],
                            }
                        controls.start_hands_free(event["timestamp"])
                    else:
                        is_pressed = action == "press"
                        if is_pressed != pressed:
                            controls.tick(event["timestamp"])
                            pressed = is_pressed
                            if pressed and not controls.recording:
                                context = {
                                    "conversation_id": event["conversation_id"],
                                    "session_id": event["session_id"],
                                }
                            controls.handle(pressed, event["timestamp"])
                else:
                    pressed, timestamp = event
                    controls.handle(pressed, timestamp)
            except Exception as error:
                if isinstance(event, dict) and event["action"] in ("release", "stop"):
                    pressed = False
                recover(error)
            publish_state()
            if isinstance(event, dict):
                notify({"type": "recording.command_completed", "session_id": event["session_id"]})
    finally:
        try:
            controls.stop()
        except Exception as error:
            recover(error)
        publish_state()

