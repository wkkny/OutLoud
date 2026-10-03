import sys
import threading
import time

Quartz = None
if sys.platform == "darwin":
    try:
        import Quartz
        from CoreFoundation import (
            CFRunLoopAddSource,
            CFRunLoopGetCurrent,
            CFRunLoopRemoveSource,
            CFRunLoopRunInMode,
            CFMachPortCreateRunLoopSource,
            kCFRunLoopCommonModes,
            kCFRunLoopDefaultMode,
            kCFRunLoopRunFinished,
            kCFRunLoopRunStopped,
        )
    except ImportError:
        Quartz = None

FN_UNSUPPORTED_PLATFORM = "Fn/Globe capture is only available on macOS."
FN_FRAMEWORKS_UNAVAILABLE = (
    "Could not load Quartz/CoreFoundation for Fn/Globe capture. "
    "Reinstall the backend dependencies and restart the app."
)


def fn_availability_error():
    if sys.platform != "darwin":
        return FN_UNSUPPORTED_PLATFORM
    if Quartz is None:
        return FN_FRAMEWORKS_UNAVAILABLE
    return None


DOUBLE_TAP_SECONDS = 0.3


class Controls:
    def __init__(self, start_recording, stop_recording):
        self.start_recording = start_recording
        self.stop_recording = stop_recording
        self.recording = False
        self.hands_free = False
        self.pressed_at = 0
        self.stop_at = None

    def stop(self):
        was_recording = self.recording
        self.recording = False
        self.hands_free = False
        self.stop_at = None
        if was_recording:
            self.stop_recording()

    def start_hands_free(self, now):
        if not self.recording:
            self.start_recording()
            self.recording = True
            self.pressed_at = now
        self.hands_free = True
        self.stop_at = None

    def tick(self, now):
        if self.stop_at is not None and now >= self.stop_at:
            self.stop()

    def handle(self, pressed, now):
        self.tick(now)
        if pressed:
            if self.hands_free:
                self.stop()
            elif self.stop_at is not None:
                self.stop_at = None
                self.hands_free = True
                print("Hands-free recording. Tap Fn to stop.", flush=True)
            else:
                self.start_recording()
                self.recording = True
                self.pressed_at = now
        elif self.recording and not self.hands_free:
            if now - self.pressed_at >= DOUBLE_TAP_SECONDS:
                self.stop()
            else:
                # Wait for a second tap without splitting the recording.
                self.stop_at = now + DOUBLE_TAP_SECONDS


class FnListener:
    """Native event tap. Construct/start/run/close on one thread; stop only signals it."""

    @staticmethod
    def availability_error():
        return fn_availability_error()

    @staticmethod
    def is_supported():
        return fn_availability_error() is None

    def __init__(self, on_key, on_failure):
        self.on_key = on_key
        self.on_failure = on_failure
        self.fn_pressed = False
        self.claimed_press = False
        self.tap = None
        self.source = None
        self.run_loop = None
        self.stopped = threading.Event()

    def on_event(self, proxy, event_type, event, refcon):
        if event_type in (
            Quartz.kCGEventTapDisabledByTimeout,
            Quartz.kCGEventTapDisabledByUserInput,
        ):
            # A release may have been lost. Stop safely, rather than silently re-enable.
            self.stopped.set()
            self.on_failure("macOS paused Fn capture. Recording was stopped; enable the shortcut again.")
            return event
        if self.stopped.is_set() or event_type != Quartz.kCGEventFlagsChanged:
            return event
        # Other modifier changes can carry the Fn flag too; never swallow those.
        if Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode) != 63:
            return event
        pressed = bool(Quartz.CGEventGetFlags(event) & Quartz.kCGEventFlagMaskSecondaryFn)
        if pressed == self.fn_pressed:
            return None if self.claimed_press else event
        self.fn_pressed = pressed
        if pressed:
            self.claimed_press = self.on_key(True, time.monotonic())
            return None if self.claimed_press else event
        if self.claimed_press:
            self.claimed_press = False
            return None if self.on_key(False, time.monotonic()) else event
        return event

    def start(self):
        availability_error = self.availability_error()
        if availability_error is not None:
            raise RuntimeError(availability_error)
        if self.stopped.is_set():
            return
        # Enabling while Fn is already held must require a fresh press.
        flags = Quartz.CGEventSourceFlagsState(Quartz.kCGEventSourceStateCombinedSessionState)
        self.fn_pressed = bool(flags & Quartz.kCGEventFlagMaskSecondaryFn)
        self.tap = Quartz.CGEventTapCreate(
            Quartz.kCGSessionEventTap,
            Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionDefault,
            Quartz.CGEventMaskBit(Quartz.kCGEventFlagsChanged),
            self.on_event,
            None,
        )
        if self.tap is None:
            raise PermissionError("macOS denied keyboard event capture")
        self.source = CFMachPortCreateRunLoopSource(None, self.tap, 0)
        if self.source is None:
            raise RuntimeError("Could not create the keyboard event source")
        self.run_loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(self.run_loop, self.source, kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(self.tap, True)

    def run(self):
        while not self.stopped.is_set():
            # Bounded waits avoid a stop-before-CFRunLoopRun race and keep cleanup local.
            result = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, False)
            if result in (kCFRunLoopRunFinished, kCFRunLoopRunStopped):
                # Missing/invalidated sources must fail capture, not busy-spin
                # while the UI still claims Fn can release the microphone.
                return

    def stop(self):
        self.stopped.set()

    def close(self):
        if self.tap is None:
            return
        tap, self.tap = self.tap, None
        try:
            Quartz.CGEventTapEnable(tap, False)
        finally:
            try:
                if self.source is not None and self.run_loop is not None:
                    CFRunLoopRemoveSource(self.run_loop, self.source, kCFRunLoopCommonModes)
            finally:
                Quartz.CFMachPortInvalidate(tap)
