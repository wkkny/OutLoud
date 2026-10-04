import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Props = { enabled: boolean; recording: boolean; level: number; occupied: boolean; pending: boolean; toggle: () => void }
const barWeights = [0.35, 0.6, 0.8, 1, 0.8, 0.6, 0.35]
export function RecordingControl({ enabled, recording, level, occupied, pending, toggle }: Props) {
  // Lift quiet speech into a visible range without inventing activity in silence.
  const amplitude = Math.min(1, Math.sqrt(level) * 3)
  const label = recording ? 'Stop recording' : 'Start recording'
  const hint = occupied ? 'Microphone occupied in another tab' : pending ? 'Applying recording control…' : recording ? 'Recording · click to stop' : 'Click to dictate · click again to stop'
  return <div className="recording-controls">
    <Tooltip><TooltipTrigger asChild><Button size="icon" variant={recording ? 'destructive' : 'ghost'} disabled={!enabled || pending || occupied} aria-label={label} aria-describedby="recording-status" aria-pressed={recording} onClick={toggle}>
      {recording ? <Square /> : <Mic />}
    </Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
    {recording && <span className="voice-level" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      {barWeights.map((weight, index) => <span key={index} aria-hidden="true" style={{ height: `${3 + amplitude * weight * 21}px` }} />)}
    </span>}
    <span id="recording-status" className={occupied || pending || recording ? 'recording-hint' : 'sr-only'} role="status">{hint}</span>
  </div>
}
