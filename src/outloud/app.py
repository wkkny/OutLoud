import queue
import time

from .recording import Recorder, is_valid_level
from .capacity import CapacityUnavailable
from .shortcuts import Controls
from .transcription import enqueue_recording


def recording_worker(events, recordings, on_event=None, recorder=None, *, reserve=lambda: None, release=lambda: None):
    recorder = recorder if recorder is not None else Recorder()
    context = {"conversation_id": None, "session_id": None}
    last_state = None
    pressed_sources = set()
    recording_id = None
    next_level_at = 0.0

    def notify(event):
        if on_event is not None:
            on_event(event)

    def save_recording(path):
        if path is not None:
            notify({"type": "recording.saved", "recording_id": path.parent.name, **context})
            enqueue_recording(recordings, path, **context, on_event=notify)

    def start_recording():
        nonlocal recording_id, next_level_at
        reserve()
        recorder.start()
        recording_id = recorder.path.parent.name
        next_level_at = 0.0

    def stop_recording():
        nonlocal recording_id
        try:
            save_recording(recorder.stop())
        finally:
            recording_id = None
            release()

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

    def publish_level():
        nonlocal next_level_at
        read_level = getattr(recorder, "read_level", None)
        if not controls.recording or not callable(read_level) or not isinstance(recording_id, str) or not recording_id:
            return
        now = time.monotonic()
        if now < next_level_at:
            return
        next_level_at = now + 0.05
        level = read_level()
        if is_valid_level(level):
            notify({"type": "recording.level", "recording_id": recording_id,
                    "session_id": context["session_id"], "level": float(level)})

    def recover(error):
        # A failed start can leave a source marked down even though capture has
        # been released. A retry (including another client) needs a fresh press.
        pressed_sources.clear()
        failed_recording_id = recording_id
        try:
            controls.stop()
        except Exception as cleanup_error:
            print(f"Recording cleanup error: {cleanup_error}", flush=True)
        save_recording(getattr(error, "saved_path", None))
        release()
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
                    # Retain duplicate-press suppression within a client, but an
                    # idle handoff must not inherit the previous client's holds.
                    if not controls.recording and event["session_id"] != context["session_id"]:
                        pressed_sources.clear()
                    action = event["action"]
                    if action == "stop":
                        pressed_sources.clear()
                        controls.stop()
                    elif action == "hands-free":
                        pressed_sources.clear()
                        controls.tick(event["timestamp"])
                        if not controls.recording:
                            context = {
                                "conversation_id": event["conversation_id"],
                                "session_id": event["session_id"],
                            }
                        controls.start_hands_free(event["timestamp"])
                    else:
                        source = event.get("source", "ui")
                        was_pressed = bool(pressed_sources)
                        fresh_press = action == "press" and source not in pressed_sources
                        if action == "press":
                            pressed_sources.add(source)
                        else:
                            pressed_sources.discard(source)
                        pressed = bool(pressed_sources)
                        if fresh_press and controls.hands_free:
                            # Either control can stop hands-free, even if another
                            # source still holds the second tap. Retain the stop
                            # press until release so a duplicate cannot restart.
                            pressed_sources.clear()
                            pressed_sources.add(source)
                            controls.stop()
                        elif pressed != was_pressed:
                            controls.tick(event["timestamp"])
                            if pressed and not controls.recording:
                                context = {
                                    "conversation_id": event["conversation_id"],
                                    "session_id": event["session_id"],
                                }
                            controls.handle(pressed, event["timestamp"])
                else:
                    pressed, timestamp = event
                    controls.handle(pressed, timestamp)
            except CapacityUnavailable as error:
                pressed_sources.clear()
                notify({"type": "recording.rejected", "message": str(error), **context})
            except Exception as error:
                if isinstance(event, dict) and event["action"] in ("release", "stop"):
                    pressed_sources.clear()
                recover(error)
            publish_state()
            publish_level()
            if isinstance(event, dict):
                notify({"type": "recording.command_completed", "session_id": event["session_id"]})
    finally:
        try:
            controls.stop()
        except Exception as error:
            recover(error)
        publish_state()
