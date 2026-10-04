import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Props = { enabled: boolean; recording: boolean; occupied: boolean; pending: boolean; toggle: () => void }
export function RecordingControl({ enabled, recording, occupied, pending, toggle }: Props) {
  const label = recording ? 'Stop recording' : 'Start recording'
  const hint = occupied ? 'Microphone occupied in another tab' : pending ? 'Applying recording control…' : recording ? 'Recording · click to stop' : 'Click to dictate · click again to stop'
  return <div className="recording-controls">
    <Tooltip><TooltipTrigger asChild><Button size="icon" variant={recording ? 'destructive' : 'ghost'} disabled={!enabled || pending || occupied} aria-label={label} aria-describedby="recording-status" aria-pressed={recording} onClick={toggle}>
      {recording ? <Square /> : <Mic />}
    </Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
    <span id="recording-status" className={occupied || pending || recording ? 'recording-hint' : 'sr-only'} role="status">{hint}</span>
  </div>
}
