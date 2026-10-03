import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, ArrowUp, Check, LoaderCircle, Plus, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RecordingControl } from '@/components/recording-control'
import { useDictation } from '@/hooks/use-dictation'
import { useChat } from '@/hooks/use-chat'
import { Toaster, toast } from 'sonner'
import './chat-ui.css'

export default function App() {
  const { sessionId, connection, snapshot, transcripts, acknowledgeTranscript, error, pastErrors, dismissPastError, pendingCommands, safety, command, handsFree, setFnEnabled, reconnect, dismissError } = useDictation()
  const [composer, setComposer] = useState<{ text: string; appliedIds: string[] }>({ text: '', appliedIds: [] })
  const draft = composer.text
  const chat = useChat(sessionId)
  const transcriptEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) toast.error('Something went wrong', { description: error, id: 'dictation-error', duration: 10_000, onDismiss: dismissError, action: { label: 'Dismiss', onClick: dismissError } })
  }, [error, dismissError])

  useEffect(() => {
    for (const { id, kind, failure } of pastErrors) {
      toast.warning(`Previous ${kind} error`, {
        id: `past-${id}`,
        duration: 60_000,
        description: <div className="toast-history-description">
          <p>{failure.message}</p>
          <p><time dateTime={failure.occurred_at}>{new Date(failure.occurred_at).toLocaleString()}</time></p>
          {failure.recording_id && <p>Recording: <span className="break-all">{failure.recording_id}</span></p>}
          <p>This happened before you connected.</p>
        </div>,
        onDismiss: () => dismissPastError(id),
        action: { label: 'Dismiss', onClick: () => { dismissPastError(id); toast.dismiss(`past-${id}`) } },
      })
    }
  }, [pastErrors, dismissPastError])

  useEffect(() => {
    if (chat.error) toast.error('Chat could not finish', { description: chat.error, id: 'chat-error', duration: 10_000, onDismiss: chat.dismissError, action: { label: 'Dismiss', onClick: chat.dismissError } })
  }, [chat.error, chat.dismissError])

  const backendUnavailable = connection === 'connected' && snapshot !== null && !snapshot.ready
  useEffect(() => {
    if (backendUnavailable) {
      toast.error('Recording backend is unavailable', {
        description: 'Check the backend terminal for errors. Restart it, then reconnect.',
        id: 'backend-unavailable',
        duration: 10_000,
      })
    } else {
      toast.dismiss('backend-unavailable')
    }
  }, [backendUnavailable])

  useEffect(() => {
    const shortcutError = snapshot?.fn_shortcut.error
    if (shortcutError) toast.error('Fn shortcut could not start', { description: shortcutError, id: 'fn-shortcut-error', duration: 10_000 })
  }, [snapshot?.fn_shortcut.error])

  const send = () => void chat.send(draft, () => {
    // Do not erase edits or new dictation that arrived while Ollama was loading.
    setComposer((previous) => previous.text === draft ? { ...previous, text: '' } : previous)
  })
  const newDraft = () => {
    if (chat.busy) return
    chat.clear()
    setComposer({ text: '', appliedIds: [] })
  }
  const consumed = useRef(0)
  const press = useCallback(() => command('press'), [command])
  const release = useCallback(() => command('release'), [command])
  const stop = useCallback(() => command('stop'), [command])

  useEffect(() => {
    const incoming = transcripts.slice(consumed.current)
    consumed.current = transcripts.length
    if (incoming.length) {
      setComposer((previous) => ({
        text: [previous.text, ...incoming.map((item) => item.text.trim())].filter(Boolean).join('\n'),
        appliedIds: [...previous.appliedIds, ...incoming.map((item) => item.recordingId)],
      }))
    }
  }, [transcripts])

  useEffect(() => {
    for (const id of composer.appliedIds) acknowledgeTranscript(id)
  }, [composer.appliedIds, acknowledgeTranscript])

  useEffect(() => {
    const end = transcriptEnd.current
    if (end && typeof end.scrollIntoView === 'function') end.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.messages])

  const connected = connection === 'connected'
  const recording = snapshot?.recording ?? false
  const processing = snapshot?.transcription.status === 'processing'
  const queued = snapshot?.transcription.queued_jobs.length ?? 0
  const controlsPending = pendingCommands > 0 || (snapshot?.pending_commands ?? 0) > 0
  const enabled = connected && safety === 'none' && (snapshot?.ready ?? false)
  const capacityFull = snapshot?.capacity.available === 0
  // Keep the held pointer alive while a start reservation is pending.
  const canStart = enabled && (!capacityFull || recording || controlsPending)
  const canStop = connected && safety === 'none' && (recording || controlsPending)
  const fnStatus = snapshot?.fn_shortcut.status ?? 'disabled'
  const fnEnabled = fnStatus === 'enabled' || fnStatus === 'starting'
  const status = recording ? 'Recording' : controlsPending ? 'Applying controls…' : processing ? 'Transcribing' : queued ? 'Queued' : enabled ? 'Ready' : 'Not ready'
  const connectionLabel = connected ? 'Connected · local' : connection === 'connecting' ? 'Connecting…' : connection === 'in-use' ? 'In use in another tab' : 'Disconnected'

  return (
    <>
    <Toaster position="top-right" richColors closeButton visibleToasts={4} />
    <div className="chat-app">
      <aside className="chat-sidebar">
        <div className="chat-brand"><span className="chat-brand-mark"><AudioLines size={18} /></span><span>OutLoud</span></div>
        <Button variant="outline" className="new-dictation" onClick={newDraft} disabled={chat.busy}>
          <Plus /> New chat
        </Button>
        <div className="sidebar-section-label">WORKSPACE</div>
        <div className="workspace-item active"><AudioLines size={16} /> Local chat</div>
        <div className="sidebar-section-label recent-label">ABOUT THIS SESSION</div>
        <p className="sidebar-note">Your conversation is kept in this page session. Audio and transcripts stay on this Mac.</p>
        <div className="sidebar-bottom">
          <details className="settings-details">
            <summary><Settings2 size={16} /> Recording settings</summary>
            <label className="fn-toggle">
              <input type="checkbox" checked={fnEnabled} disabled={!connected || safety !== 'none' || pendingCommands > 0 || (!snapshot?.ready && !fnEnabled)} onChange={(event) => void setFnEnabled(event.target.checked)} aria-describedby="fn-help" />
              <span>Enable Fn shortcut</span>
            </label>
            <p id="fn-help">{fnStatus === 'starting' ? 'Enabling keyboard capture…' : 'Hold Fn/Globe to record; double-tap for hands-free, then tap to stop.'} While enabled, Fn is captured across apps while this tab stays connected. Turning it off stops recording and restores its default action.</p>
          </details>
          <div className="profile-row"><span className="profile-avatar">L</span><span><b>Local workspace</b><small>Private on this Mac</small></span><Badge variant="outline" className="local-badge">LOCAL</Badge></div>
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-topbar">
          <div className="mobile-brand"><span className="chat-brand-mark"><AudioLines size={17} /></span><b>OutLoud</b></div>
          <div className="conversation-title">Local chat <span className="model-label">· Gemma</span></div>
          <div className="topbar-status" role="status" aria-live="polite"><span className={`status-dot ${recording ? 'is-recording' : connected ? 'is-connected' : ''}`} />{connectionLabel}</div>
        </header>

        <div className="chat-content">
          <div className="session-alerts">
            {!connected && <Alert className="session-alert">
              <AlertTitle>{connection === 'in-use' ? 'Another tab is using the microphone session' : 'Connect to your local backend'}</AlertTitle>
              <AlertDescription>
                <p>{connection === 'in-use' ? 'Close the other tab, then reconnect here.' : <>Run <code className="rounded bg-muted px-1 py-0.5">uv run outloud</code> in the project folder.</>}</p>
                <Button variant="outline" size="sm" className="mt-2 w-fit" disabled={connection === 'connecting' || safety === 'stopping'} onClick={() => void reconnect()}><RefreshCw /> Reconnect</Button>
              </AlertDescription>
            </Alert>}
            {safety !== 'none' && <Alert variant={safety === 'unconfirmed' ? 'destructive' : 'default'} className="session-alert">
              <AlertTitle>{safety === 'stopping' ? 'Stopping recording safely…' : safety === 'stopped' ? 'Backend confirmed recording stopped' : 'Recording stop is unconfirmed'}</AlertTitle>
              <AlertDescription>{safety === 'stopping' ? 'The session is closed. Waiting for the backend to confirm the microphone is idle.' : safety === 'stopped' ? 'Reconnect before recording again. Saved audio remains on disk.' : 'Check or restart the backend. Reconnect will check that recording has stopped before opening another session.'}</AlertDescription>
            </Alert>}
          </div>

          <section className="conversation" aria-label="Conversation">
            {chat.messages.length === 0 ? <div className="empty-conversation">
              <div className="welcome-mark"><Sparkles size={21} /></div>
              <h1>What would you like to say?</h1>
              <p>Speak naturally or type a message. Review your words, then send them to Gemma.</p>
              <div className="welcome-tip"><AudioLines size={17} /><span><b>Voice-first, always editable</b><small>Hold the mic to dictate. Your transcript lands in the composer before anything is sent.</small></span></div>
            </div> : <ol className="message-list">
              {chat.messages.map((message) => <li className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}>
                <div className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'user' ? 'Y' : <Sparkles size={16} />}</div>
                <div className="message-body"><div className="message-author">{message.role === 'user' ? 'You' : 'Gemma'}{message.role === 'assistant' && message.status === 'complete' && <span className="local-answer"><Check size={12} /> Local</span>}</div>
                  <p className="message-content">{message.content || (message.status === 'streaming' ? <span className="thinking"><LoaderCircle size={14} /> Thinking…</span> : 'No reply received.')}</p>
                  {message.role === 'assistant' && message.status !== 'complete' && <p className="message-meta">{message.status === 'streaming' ? 'Generating…' : message.status === 'cancelled' ? 'Stopped · partial reply' : 'Failed · partial reply'}</p>}
                  {message.role === 'assistant' && message.metrics && <p className="message-meta">{message.metrics.elapsed_seconds.toFixed(1)}s{message.metrics.output_tokens !== undefined && ` · ${message.metrics.output_tokens} output tokens`}</p>}
                  {message.role === 'user' && (message.status === 'failed' || message.status === 'cancelled') && <Button variant="ghost" size="sm" className="mt-1" onClick={() => setComposer((previous) => ({ ...previous, text: [previous.text, message.content].filter(Boolean).join('\n') }))}>Use this text again</Button>}
                </div>
              </li>)}
              <div ref={transcriptEnd} />
            </ol>}
          </section>

          <div className="composer-dock">
            {snapshot && <div className="capacity-note" role="status">{processing && !recording && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />}{snapshot.capacity.used} of {snapshot.capacity.limit} transcription slots used{capacityFull && ' · Capacity full; wait for a job to finish'}{queued > 0 && ` · ${queued} queued`}{controlsPending ? <span>Sending recording controls…</span> : <span>· {status}</span>}</div>}
            {!snapshot && <div className="capacity-note" role="status">{connection === 'connecting' ? 'Connecting to local services…' : 'Microphone unavailable'}</div>}
            <div className="message-composer">
              <label htmlFor="composer" className="sr-only">Your text</label>
              <Textarea id="composer" value={draft} onChange={(event) => setComposer((previous) => ({ ...previous, text: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() } }} placeholder="Message OutLoud" className="composer-input" />
              <div className="composer-toolbar"><span className="composer-hint"><AudioLines size={14} /> Transcript stays editable until you send</span><div className="composer-buttons">
                {chat.busy ? <Button variant="outline" size="sm" onClick={() => void chat.stop()} aria-label="Stop generation">Stop generation</Button> : <Button disabled={!connected || safety !== 'none' || !draft.trim()} onClick={send} aria-label="Send message" className="send-button"><ArrowUp size={17} /><span>Send</span></Button>}
              </div></div>
            </div>
            <div className="recording-row"><RecordingControl enabled={canStart} recording={recording} handsFree={snapshot?.hands_free ?? false} pending={controlsPending} canStop={canStop} press={press} release={release} stop={stop} startHandsFree={handsFree} /></div>
            <footer className="privacy-footer"><span><Check size={12} /> Audio and transcripts stay on this Mac</span><span>Whisper transcription · Gemma chat runs locally</span></footer>
          </div>
        </div>
      </main>
    </div>
    </>
  )
}
