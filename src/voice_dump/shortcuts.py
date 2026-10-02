import time

import Quartz
from CoreFoundation import (
    CFRunLoopAddSource,
    CFRunLoopGetCurrent,
    CFRunLoopRemoveSource,
    CFRunLoopRun,
    CFMachPortCreateRunLoopSource,
    kCFRunLoopCommonModes,
)

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
    def __init__(self, events):
        self.events = events
        self.fn_pressed = False
        self.tap = None

    def on_event(self, proxy, event_type, event, refcon):
        if event_type in (
            Quartz.kCGEventTapDisabledByTimeout,
            Quartz.kCGEventTapDisabledByUserInput,
        ):
            Quartz.CGEventTapEnable(self.tap, True)
            return event

        flags = Quartz.CGEventGetFlags(event)
        pressed = bool(flags & Quartz.kCGEventFlagMaskSecondaryFn)
        if pressed != self.fn_pressed:
            self.fn_pressed = pressed
            # Keep microphone and disk work out of the keyboard callback.
            self.events.put((pressed, time.monotonic()))
            return None
        return event

    def start(self):
        self.tap = Quartz.CGEventTapCreate(
            Quartz.kCGSessionEventTap,
            Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionDefault,
            Quartz.CGEventMaskBit(Quartz.kCGEventFlagsChanged),
            self.on_event,
            None,
        )
        if self.tap is None:
            raise SystemExit(
                "Cannot capture keyboard events. Enable Accessibility permission "
                "for your terminal, then quit and reopen it."
            )
        self.source = CFMachPortCreateRunLoopSource(None, self.tap, 0)
        self.run_loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(self.run_loop, self.source, kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(self.tap, True)

    def run(self):
        CFRunLoopRun()

    def stop(self):
        Quartz.CGEventTapEnable(self.tap, False)
        CFRunLoopRemoveSource(self.run_loop, self.source, kCFRunLoopCommonModes)
        Quartz.CFMachPortInvalidate(self.tap)
