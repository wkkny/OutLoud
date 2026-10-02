import copy
import logging
import queue
import threading
import time
from datetime import datetime, timezone

from .app import recording_worker
from .delivery import TranscriptInbox
from .fn_shortcut import FnShortcut
from .transcription import transcription_worker

logger = logging.getLogger(__name__)


class RuntimeUnavailable(RuntimeError):
    pass


class RecordingRuntime:
    """Own workers and publish atomic, metadata-only state snapshots."""

    def __init__(self, on_event, recorder=None, *, recording_target=None, transcription_target=None, fn_listener_factory=None):
        self.on_event = on_event
        self.recorder = recorder
        self.recording_target = recording_target or recording_worker
        self.transcription_target = transcription_target or transcription_worker
        self.events = queue.Queue()
        self.recordings = queue.Queue()
        self.lock = threading.RLock()
        self.recording = {
            "recording": False,
            "hands_free": False,
            "recording_id": None,
            "conversation_id": None,
        }
        self.active_job = None
        self.queued_jobs = []
        self.errors = {"recording": None, "transcription": None}
        self.workers = {
            name: {"status": "stopped", "error": None}
            for name in ("recording", "transcription")
        }
        self.threads = {}
        self.shutting_down = False
        self.revision = 0
        self.pending_commands = 0
        self.owner_session_id = None
        self.fn_shortcut = FnShortcut(self, fn_listener_factory)
        self.transcripts = TranscriptInbox()

    def worker_running(self, name):
        thread = self.threads.get(name)
        return self.workers[name]["status"] == "running" and thread is not None and thread.is_alive()

    def readiness(self):
        with self.lock:
            ready = not self.shutting_down and all(self.worker_running(name) for name in self.workers)
            return {
                "ready": ready,
                "shutting_down": self.shutting_down,
                "workers": copy.deepcopy(self.workers),
            }

    def snapshot(self):
        with self.lock:
            available = self.worker_running("transcription")
            transcription_status = (
                "unavailable" if not available else
                "processing" if self.active_job is not None else
                "queued" if self.queued_jobs else "idle"
            )
            return copy.deepcopy({
                "revision": self.revision,
                "pending_commands": self.pending_commands,
                "fn_shortcut": self.fn_shortcut.state,
                **self.recording,
                "mode": "hands_free" if self.recording["hands_free"] else
                        "hold" if self.recording["recording"] else None,
                "transcription": {
                    "status": transcription_status,
                    "active_job": self.active_job,
                    "queued_jobs": self.queued_jobs,
                },
                "errors": self.errors,
                **self.readiness(),
            })

    def notify(self, event):
        try:
            self.on_event(event)
        except Exception:
            logger.exception("Could not deliver backend event")

    def state_changed(self):
        # Called under the lock; callbacks only enqueue events, preserving revision order.
        self.revision += 1
        self.notify({"type": "state.updated", "state": self.snapshot()})

    @staticmethod
    def job_metadata(event):
        return {key: event.get(key) for key in ("recording_id", "conversation_id")}

    def remember_error(self, kind, event):
        # Raw exception text can contain paths. Keep it in logs/diagnostic events,
        # not in the metadata snapshot.
        self.errors[kind] = {
            **self.job_metadata(event),
            "message": f"{kind.capitalize()} failed. See server logs for details.",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }

    def publish(self, event):
        with self.lock:
            event_type = event["type"]
            deliver = event_type != "transcription.completed" or self.transcripts.remember(event)
            if event_type == "recording.command_completed":
                self.pending_commands = max(0, self.pending_commands - 1)
            elif event_type == "recording.state":
                self.recording = {key: event.get(key) for key in self.recording}
            elif event_type == "transcription.queued":
                self.queued_jobs.append(self.job_metadata(event))
            elif event_type == "transcription.started":
                self.queued_jobs = [job for job in self.queued_jobs if job["recording_id"] != event["recording_id"]]
                self.active_job = self.job_metadata(event)
            elif event_type in ("transcription.completed", "transcription.error"):
                if self.active_job is not None and self.active_job["recording_id"] == event["recording_id"]:
                    self.active_job = None
                if event_type == "transcription.error":
                    self.remember_error("transcription", event)
            elif event_type == "recording.error":
                self.remember_error("recording", event)
            if event_type != "recording.command_completed" and deliver:
                self.notify(event)
            self.state_changed()

    def run_worker(self, name, target, args, started):
        with self.lock:
            self.workers[name] = {"status": "running", "error": None}
            self.state_changed()
        started.set()
        failure = None
        try:
            target(*args)
        except BaseException as error:
            failure = type(error).__name__
            logger.exception("%s worker crashed", name)
        finally:
            with self.lock:
                unexpected = failure is not None or not self.shutting_down
                error = None
                if unexpected:
                    error = {
                        "type": failure or "UnexpectedExit",
                        "message": f"{name.capitalize()} worker exited unexpectedly. See server logs.",
                    }
                    if failure is None:
                        logger.error("%s worker returned unexpectedly", name)
                self.workers[name] = {"status": "failed" if unexpected else "stopped", "error": error}
                if unexpected and self.fn_shortcut.state["status"] in ("starting", "enabled"):
                    session_id = self.owner_session_id
                    self.fn_shortcut.disable("Recording workers are unavailable. Restart the backend.")
                    self.stop_recording(session_id)
                if name == "recording":
                    self.recording = {
                        "recording": False, "hands_free": False,
                        "recording_id": None, "conversation_id": None,
                    }
                elif self.active_job is not None:
                    self.remember_error("transcription", self.active_job)
                    self.active_job = None
                self.notify({"type": "worker.state", "worker": name, **self.workers[name]})
                self.state_changed()

    def start(self):
        targets = {
            "recording": (self.recording_target, (self.events, self.recordings, self.publish, self.recorder)),
            "transcription": (self.transcription_target, (self.recordings, self.publish)),
        }
        started = {name: threading.Event() for name in targets}
        with self.lock:
            for name, (target, args) in targets.items():
                self.workers[name]["status"] = "starting"
                self.threads[name] = threading.Thread(
                    target=self.run_worker, args=(name, target, args, started[name]),
                    name=f"outloud-{name}",
                )
        for thread in self.threads.values():
            thread.start()
        for event in started.values():
            event.wait()

    def claim_owner(self, session_id):
        with self.lock:
            self.owner_session_id = session_id
            self.fn_shortcut.disable()

    def release_owner(self, session_id):
        with self.lock:
            if self.owner_session_id != session_id:
                return
            self.owner_session_id = None
            self.fn_shortcut.disable()
            self.stop_recording(session_id)

    def configure_fn(self, session_id, enabled, conversation_id):
        with self.lock:
            if self.owner_session_id != session_id:
                raise RuntimeUnavailable("An active owner session is required")
            if enabled and not self.readiness()["ready"]:
                raise RuntimeUnavailable("Required workers are unavailable; restart the backend")
            self.fn_shortcut.configure(enabled, session_id, conversation_id)

    def command(self, action, session_id, conversation_id=None, *, timestamp=None, source="ui"):
        with self.lock:
            # Release/stop remain available if transcription fails, so audio can be finalized.
            required = ("recording",) if action in ("release", "stop") else tuple(self.workers)
            if self.shutting_down or not all(self.worker_running(name) for name in required):
                raise RuntimeUnavailable("Required workers are unavailable; restart the backend")
            self.pending_commands += 1
            self.events.put({
                "action": action,
                "timestamp": time.monotonic() if timestamp is None else timestamp,
                "source": source,
                "session_id": session_id,
                "conversation_id": conversation_id,
            })
            self.state_changed()

    def stop_recording(self, session_id):
        try:
            self.command("stop", session_id)
        except RuntimeUnavailable:
            # Disconnect cleanup may race shutdown or an already exited worker.
            pass

    def stop(self):
        with self.lock:
            if self.shutting_down:
                return
            self.shutting_down = True
            self.owner_session_id = None
            self.fn_shortcut.disable()
            self.events.put(None)
        self.fn_shortcut.join()
        self.threads["recording"].join()
        self.recordings.put(None)
        self.threads["transcription"].join()
