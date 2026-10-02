import logging
import threading

from .capacity import CapacityUnavailable
from .shortcuts import FnListener

logger = logging.getLogger(__name__)

PERMISSION_HELP = (
    "Could not capture Fn. In macOS System Settings → Privacy & Security, "
    "allow Accessibility (and Input Monitoring if requested) for the terminal "
    "or app launching OutLoud. Restart the backend, reconnect, and enable Fn again."
)


class FnShortcut:
    """Session-scoped capture, guarded by the runtime lock, with native work off HTTP."""

    def __init__(self, runtime, listener_factory=None):
        self.runtime = runtime
        self.listener_factory = listener_factory or FnListener
        self.state = {"status": "disabled", "error": None}
        self.session_id = None
        self.conversation_id = None
        self.generation = 0
        self.listeners = {}
        self.threads = []

    def configure(self, enabled, session_id, conversation_id):
        # All configuration and callbacks share the runtime lock: disable cannot
        # race a final key command into the queue after its stop command.
        if not enabled:
            was_enabled = self.state["status"] in ("starting", "enabled")
            self.disable()
            if was_enabled:
                self.runtime.stop_recording(session_id)
            return
        self.session_id = session_id
        self.conversation_id = conversation_id
        if self.state["status"] in ("starting", "enabled"):
            return
        self.generation += 1
        generation = self.generation
        self.state = {"status": "starting", "error": None}
        self.runtime.state_changed()
        self.threads = [thread for thread in self.threads if thread.is_alive()]
        thread = threading.Thread(target=self.run, args=(generation,), name="outloud-fn", daemon=True)
        self.threads.append(thread)
        try:
            thread.start()
        except RuntimeError:
            self.threads.remove(thread)
            logger.exception("Could not start Fn capture thread")
            self.fail(generation, "Could not start Fn capture. Restart the backend and try again.")

    def disable(self, error=None):
        self.generation += 1
        self.session_id = None
        self.conversation_id = None
        self.state = {"status": "failed" if error else "disabled", "error": error}
        for listener in self.listeners.values():
            listener.stop()
        self.runtime.state_changed()

    def current(self, generation):
        return (
            generation == self.generation
            and self.session_id is not None
            and self.session_id == self.runtime.owner_session_id
            and not self.runtime.shutting_down
        )

    def fail(self, generation, message):
        with self.runtime.lock:
            if not self.current(generation):
                return
            session_id = self.session_id
            could_have_recorded = self.state["status"] == "enabled"
            self.disable(message)
            if could_have_recorded:
                self.runtime.stop_recording(session_id)

    def key(self, generation, pressed, timestamp):
        with self.runtime.lock:
            if not self.current(generation) or self.state["status"] != "enabled":
                return False
            # A failed required worker must immediately stop interception, even
            # before its supervision callback has published the failure.
            if not self.runtime.readiness()["ready"]:
                self.fail(generation, "Recording workers are unavailable. Restart the backend.")
                return False
            try:
                self.runtime.command(
                    "press" if pressed else "release", self.session_id, self.conversation_id,
                    timestamp=timestamp, source="fn",
                )
            except CapacityUnavailable as error:
                self.runtime.notify({
                    "type": "recording.rejected", "message": str(error),
                    "session_id": self.session_id, "conversation_id": self.conversation_id,
                })
            return True

    def run(self, generation):
        listener = None
        started = False
        try:
            with self.runtime.lock:
                if not self.current(generation):
                    return
            listener = self.listener_factory(
                lambda pressed, timestamp: self.key(generation, pressed, timestamp),
                lambda message: self.fail(generation, message),
            )
            with self.runtime.lock:
                if not self.current(generation):
                    return
                self.listeners[generation] = listener
            listener.start()
            with self.runtime.lock:
                if not self.current(generation):
                    return
                self.state = {"status": "enabled", "error": None}
                self.runtime.state_changed()
            started = True
            listener.run()
            self.fail(generation, "Fn capture exited unexpectedly. Enable the shortcut again.")
        except BaseException:
            # Like required workers, supervise every thread exit. SystemExit must
            # not leave an enabled shortcut or a recording with no release path.
            logger.exception("Fn capture failed")
            self.fail(generation, "Fn capture failed. Enable the shortcut again." if started else PERMISSION_HELP)
        finally:
            if listener is not None:
                try:
                    listener.stop()
                    listener.close()
                except BaseException:
                    logger.exception("Could not close Fn capture")
            with self.runtime.lock:
                self.listeners.pop(generation, None)

    def join(self):
        for thread in self.threads:
            thread.join()
