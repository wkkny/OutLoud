import { useEffect, useRef } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  enabled: boolean
  recording: boolean
  handsFree: boolean
  pending: boolean
  canStop: boolean
  press: () => Promise<boolean>
  release: () => Promise<boolean>
  stop: () => Promise<boolean>
  startHandsFree: () => Promise<boolean>
}

export function RecordingControl({ enabled, recording, handsFree, pending, canStop, press, release, stop, startHandsFree }: Props) {
  const held = useRef<number | 'keyboard' | null>(null)

  useEffect(() => {
    if (!enabled && !recording) held.current = null
  }, [enabled, recording])

  useEffect(() => {
    const cancel = () => {
      if (held.current !== null) {
        held.current = null
        void stop()
      }
    }
    const pointerUp = (event: PointerEvent) => {
      if (held.current === event.pointerId) {
        held.current = null
        void release()
      }
    }
    const pointerCancel = (event: PointerEvent) => {
      if (held.current === event.pointerId) cancel()
    }
    const hidden = () => { if (document.hidden) cancel() }
    // Window listeners also cover release outside the button if capture is unavailable.
    window.addEventListener('pointerup', pointerUp)
    window.addEventListener('pointercancel', pointerCancel)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerup', pointerUp)
      window.removeEventListener('pointercancel', pointerCancel)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hidden)
      cancel()
    }
  }, [release, stop])

  const begin = (source: number | 'keyboard') => {
    if (held.current !== null) return
    if (handsFree) {
      void stop()
    } else if (enabled) {
      held.current = source
      void press()
    }
  }
  const end = (source: number | 'keyboard') => {
    if (held.current === source) {
      held.current = null
      void release()
    }
  }
  const cancel = () => {
    if (held.current !== null) {
      held.current = null
      void stop()
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <Button
        size="lg"
        className="h-14 min-w-52 touch-none gap-3 text-base"
        disabled={!enabled && !recording}
        aria-describedby="recording-help"
        onPointerDown={(event) => {
          if (event.button !== 0 || held.current !== null) return
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // Window listeners still observe release/cancel if capture fails.
          }
          begin(event.pointerId)
        }}
        onPointerUp={(event) => end(event.pointerId)}
        onPointerCancel={(event) => { if (held.current === event.pointerId) cancel() }}
        onLostPointerCapture={(event) => { if (held.current === event.pointerId) cancel() }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            if (!event.repeat) begin('keyboard')
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            end('keyboard')
          }
        }}
        onBlur={cancel}
      >
        {handsFree ? <Square className="size-5" /> : <Mic className="size-5" />}
        {handsFree ? 'Stop recording' : recording ? 'Release to stop' : 'Hold to record'}
      </Button>
      <p id="recording-help" className="text-center text-sm text-muted-foreground">
        Hold to speak. Double-tap to record hands-free.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!enabled || recording || pending} onClick={() => void startHandsFree()}>
          Record hands-free
        </Button>
        <Button variant="ghost" size="sm" disabled={!canStop} onClick={() => { held.current = null; void stop() }}>
          <Square /> Stop
        </Button>
      </div>
    </div>
  )
}
