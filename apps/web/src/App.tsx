import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { RecordingControl } from '@/components/recording-control'
import { useDictation } from '@/hooks/use-dictation'

export default function App() {
  const { connection, snapshot, transcripts, error, pastErrors, dismissPastError, pendingCommands, safety, command, handsFree, reconnect, dismissError } = useDictation()
  const [draft, setDraft] = useState('')
  const consumed = useRef(0)
  const press = useCallback(() => command('press'), [command])
  const release = useCallback(() => command('release'), [command])
  const stop = useCallback(() => command('stop'), [command])

  useEffect(() => {
    const incoming = transcripts.slice(consumed.current).map((item) => item.text.trim()).filter(Boolean)
    consumed.current = transcripts.length
    if (incoming.length) {
      setDraft((previous) => [previous, ...incoming].filter(Boolean).join('\n'))
    }
  }, [transcripts])

  const connected = connection === 'connected'
  const recording = snapshot?.recording ?? false
  const processing = snapshot?.transcription.status === 'processing'
  const queued = snapshot?.transcription.queued_jobs.length ?? 0
  const controlsPending = pendingCommands > 0 || (snapshot?.pending_commands ?? 0) > 0
  const enabled = connected && safety === 'none' && (snapshot?.ready ?? false)
  const canStop = connected && safety === 'none' && (recording || controlsPending)
  const status = recording ? 'Recording' : controlsPending ? 'Applying controls…' : processing ? 'Transcribing' : queued ? 'Queued' : enabled ? 'Ready' : 'Not ready'

  return (
    <div className="min-h-svh bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 sm:px-8">
          <span className="text-sm font-semibold tracking-tight">OutLoud</span>
          <Badge variant="outline" className="font-normal">
            {connected ? 'Connected · local' : connection === 'connecting' ? 'Connecting…' : connection === 'in-use' ? 'In use in another tab' : 'Disconnected'}
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-10 sm:px-8 sm:py-14">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dictation</h1>
          <p className="mt-2 text-sm text-muted-foreground">Speak, then review and edit your text.</p>
        </div>

        {!connected && (
          <Alert>
            <AlertTitle>{connection === 'in-use' ? 'Another tab is using the microphone session' : 'Connect to your local backend'}</AlertTitle>
            <AlertDescription>
              <p>{connection === 'in-use' ? 'Close the other tab, then reconnect here.' : <>Run <code className="rounded bg-muted px-1 py-0.5">uv run outloud</code> in the project folder.</>}</p>
              <Button variant="outline" size="sm" className="mt-2 w-fit" disabled={connection === 'connecting' || safety === 'stopping'} onClick={() => void reconnect()}>
                <RefreshCw /> Reconnect
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {connected && !snapshot?.ready && (
          <Alert variant="destructive">
            <AlertTitle>Recording backend is unavailable</AlertTitle>
            <AlertDescription>Check the backend terminal for errors. Restart it, then reconnect.</AlertDescription>
          </Alert>
        )}

        {safety !== 'none' && (
          <Alert variant={safety === 'unconfirmed' ? 'destructive' : 'default'}>
            <AlertTitle>{safety === 'stopping' ? 'Stopping recording safely…' : safety === 'stopped' ? 'Backend confirmed recording stopped' : 'Recording stop is unconfirmed'}</AlertTitle>
            <AlertDescription>
              {safety === 'stopping' ? 'The session is closed. Waiting for the backend to confirm the microphone is idle.' : safety === 'stopped' ? 'Reconnect before recording again. Saved audio remains on disk.' : 'Check or restart the backend. Reconnect will check that recording has stopped before opening another session.'}
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive" className="relative pr-12">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2" aria-label="Dismiss error" onClick={dismissError}><X /></Button>
          </Alert>
        )}

        {pastErrors.map(({ id, kind, failure }) => (
          <Alert key={id} className="relative pr-12">
            <AlertTitle>Previous {kind} error</AlertTitle>
            <AlertDescription>
              <p>{failure.message}</p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={failure.occurred_at}>{new Date(failure.occurred_at).toLocaleString()}</time>
                {failure.recording_id && <> · Recording: <span className="break-all">{failure.recording_id}</span></>}
              </p>
              <p className="text-xs text-muted-foreground">This happened before you connected. See the current recording status for availability.</p>
            </AlertDescription>
            <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2" aria-label={`Dismiss previous ${kind} error`} onClick={() => dismissPastError(id)}><X /></Button>
          </Alert>
        ))}

        <Card className="shadow-none">
          <CardContent className="flex flex-col gap-6 pt-6">
            <div className="flex items-center justify-between gap-3 text-sm" role="status" aria-live="polite">
              <span className="flex items-center gap-2 text-muted-foreground">
                {processing && !recording ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <span className={`size-2 rounded-full ${recording ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />}
                {connected ? status : 'Microphone unavailable'}
              </span>
              {queued > 0 && <span className="text-xs text-muted-foreground">{queued} queued</span>}
            </div>
            <div className="pb-3 pt-2">
              <p role="status" className="mb-3 h-4 text-center text-xs text-muted-foreground">
                {controlsPending ? 'Sending recording controls…' : ''}
              </p>
              <RecordingControl enabled={enabled} recording={recording} handsFree={snapshot?.hands_free ?? false} pending={controlsPending} canStop={canStop} press={press} release={release} stop={stop} startHandsFree={handsFree} />
            </div>
            <div className="border-t pt-5">
              <label htmlFor="composer" className="text-sm font-medium">Your text</label>
              <Textarea
                id="composer"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Your transcript will appear here. You can also type."
                className="mt-3 min-h-48 resize-y text-base leading-relaxed shadow-none"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">Transcripts append here. Nothing sends automatically.</span>
                <Button disabled aria-label="Send message — chat is not connected yet" title="Chat is not connected yet"><ArrowUp /> Send</Button>
              </div>
            </div>
          </CardContent>
        </Card>
        <footer className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
          <p>Audio and transcripts stay on this Mac. Transcription uses Whisper base.</p>
          <p>Fn shortcut and local Gemma chat are not connected to this UI yet.</p>
        </footer>
      </main>
    </div>
  )
}
