import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = { enabled: boolean; recording: boolean; occupied: boolean; pending: boolean; toggle: () => void }
export function RecordingControl({ enabled, recording, occupied, pending, toggle }: Props) {
  return <div className="recording-controls">
    <Button className={`mic-button ${recording ? 'is-recording' : ''}`} variant={recording ? 'destructive' : 'outline'} disabled={!enabled || pending || occupied} aria-label={recording ? 'Stop recording' : 'Start recording'} aria-pressed={recording} onClick={toggle}>
      {recording ? <Square size={16} /> : <Mic size={18} />}{recording ? 'Stop recording' : 'Start recording'}
    </Button>
    <span className="recording-hint" role="status">{occupied ? 'Microphone occupied in another tab' : pending ? 'Applying recording control…' : recording ? 'Recording · click to stop' : 'Click to dictate · click again to stop'}</span>
  </div>
}
