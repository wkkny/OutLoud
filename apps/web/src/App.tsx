import { useState } from 'react'
import { AudioLines, ArrowUp, Check, Plus, RefreshCw, Sparkles } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RecordingControl } from '@/components/recording-control'
import { useDictation } from '@/hooks/use-dictation'
import { useConversations } from '@/hooks/use-conversations'
import { useChat } from '@/hooks/use-chat'
import type { ConversationDetail, ConversationLibrary } from '@/lib/conversations'
import './chat-ui.css'

function ConversationActions({ conversation, library, enabled }: {
  conversation: ConversationDetail; library: ConversationLibrary; enabled: boolean
}) {
  const [title, setTitle] = useState(conversation.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  return <form className="conversation-actions" onSubmit={(event) => {
    event.preventDefault()
    void library.rename(conversation.id, title)
  }}>
    <label className="sr-only" htmlFor="conversation-title">Conversation title</label>
    <input id="conversation-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
    <Button variant="outline" type="submit" disabled={!enabled || !title.trim()}>Rename conversation</Button>
    <Button variant="ghost" type="button" onClick={() => setConfirmDelete(true)} disabled={!enabled}>Delete conversation</Button>
    {confirmDelete && <span role="alert" className="delete-confirmation">
      Delete this conversation and its saved content?
      <Button type="button" variant="destructive" onClick={() => void library.delete(conversation.id)}>Confirm delete</Button>
      <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep conversation</Button>
    </span>}
  </form>
}

export default function App() {
  const conversations = useConversations()
  const dictation = useDictation(conversations.library)
  const { library, selectedId, list, details, historyRevisions, drafts } = conversations
  const selected = selectedId ? details[selectedId] : undefined
  const draft = selectedId ? drafts[selectedId] : undefined
  const chat = useChat(dictation.sessionId, selectedId, details, historyRevisions, library)
  const [sending, setSending] = useState(false)
  const connected = dictation.connection === 'connected'
  const recording = dictation.snapshot?.capture_owned ?? false
  const occupied = Boolean(dictation.snapshot?.recording && !recording)
  const micEnabled = connected && dictation.safety === 'none' && (recording || Boolean(selected && dictation.snapshot?.ready && dictation.snapshot.capacity.available > 0))
  const canSend = connected && Boolean(draft?.text.trim()) && draft?.conflict === null && !chat.busy && !sending
  const recovered = Object.entries(drafts).filter(([id, item]) => !list.some((conversation) => conversation.id === id) && item.text !== item.base)
  const send = async () => {
    if (!selectedId || !draft || !canSend) return
    const id = selectedId
    const text = draft.text
    setSending(true)
    try {
      if (!await library.save(id)) return
      // An append/conflict during saving must be reviewed before sending.
      if (library.getSnapshot().drafts[id]?.text !== text) return
      void chat.send(id, text, () => { void library.clearAccepted(id, text) })
    } finally { setSending(false) }
  }

  return <div className="chat-app">
    <aside className="chat-sidebar">
      <div className="chat-brand"><span className="chat-brand-mark"><AudioLines size={18} /></span><span>OutLoud</span></div>
      <Button variant="outline" className="new-dictation" onClick={() => void library.create()} disabled={!connected}><Plus /> New chat</Button>
      <div className="sidebar-section-label">CONVERSATIONS</div>
      <nav aria-label="Conversations" className="conversation-library">
        {list.map((item) => <button key={item.id} className={`workspace-item ${selectedId === item.id ? 'active' : ''}`} aria-label={`Select ${item.title}`} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => library.select(item.id)}>
          <AudioLines size={16} /><span>{item.title}</span>
        </button>)}
      </nav>
      <p className="sidebar-note">Conversations are saved on this Mac and shared across tabs. This tab remembers its selected chat.</p>
      <div className="sidebar-bottom"><div className="profile-row"><span className="profile-avatar">L</span><span><b>Local workspace</b><small>Private on this Mac</small></span></div></div>
    </aside>
    <main className="chat-main">
      <header className="chat-topbar">
        <div className="conversation-title">{selected?.title ?? 'Choose a conversation'} <span className="model-label">· Gemma</span></div>
        <div className="topbar-status" role="status">{connected ? 'Connected · local' : dictation.connection === 'exhausted' ? 'Connection retries exhausted' : dictation.connection === 'retrying' ? 'Reconnecting with backoff…' : 'Connecting…'}</div>
      </header>
      <div className="chat-content">
        <div className="session-alerts">
          {!connected && <Alert className="session-alert">
            <AlertTitle>{dictation.connection === 'exhausted' ? 'Automatic retries have stopped' : 'Connect to your local backend'}</AlertTitle>
            <AlertDescription><p>Run <code>uv run outloud</code> in the project folder. Your selected conversation and local drafts are retained.</p><Button variant="outline" size="sm" disabled={dictation.safety === 'stopping'} onClick={() => dictation.reconnect()}><RefreshCw /> Reconnect</Button></AlertDescription>
          </Alert>}
          {dictation.safety !== 'none' && <Alert variant={dictation.safety === 'unconfirmed' ? 'destructive' : 'default'}>
            <AlertTitle>{dictation.safety === 'stopping' ? 'Stopping recording safely…' : dictation.safety === 'unconfirmed' ? 'Recording stop is unconfirmed' : 'Backend confirmed this tab’s recording stopped'}</AlertTitle>
            <AlertDescription>{dictation.safety === 'unconfirmed' ? 'Check or restart the backend. Reconnect will verify this client has released capture before starting a new session.' : 'Checking this tab’s capture only; other tabs may stay connected.'}</AlertDescription>
          </Alert>}
          {(conversations.error || dictation.error || chat.error) && <Alert variant="destructive"><AlertTitle>Backend request failed</AlertTitle><AlertDescription>{chat.error || conversations.error || dictation.error}</AlertDescription></Alert>}
          {recovered.length > 0 && <details className="recovered-drafts"><summary>Recovered unsaved drafts from unavailable conversations</summary>{recovered.map(([id, item]) => <div key={id}><p>Conversation {id} · copy this text to a new chat to keep working.</p><pre>{item.text}</pre></div>)}</details>}
        </div>
        {selected && <ConversationActions key={`${selected.id}:${selected.title}`} conversation={selected} library={library} enabled={connected} />}
        {!selected && !conversations.loading && list.length === 0 && connected && <p className="capacity-note">Create a new chat to start. Your conversations will be saved locally.</p>}
        <section className="conversation" aria-label="Conversation">
          {!chat.messages.length ? <div className="empty-conversation">
            <div className="welcome-mark"><Sparkles size={21} /></div>
            <h1>What would you like to say?</h1>
            <p>Speak naturally or type a message. Review your words, then send them to Gemma.</p>
          </div> : <ol className="message-list">
            {chat.messages.map((message) => <li className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}>
              <div className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'user' ? 'Y' : <Sparkles size={16} />}</div>
              <div className="message-body">
                <div className="message-author">{message.role === 'user' ? 'You' : 'Gemma'}</div>
                <p className="message-content">{message.content || (message.status === 'streaming' ? 'Thinking…' : 'No reply received.')}</p>
                {message.status !== 'complete' && <p className="message-meta">{message.status === 'streaming' ? 'Generating…' : `${message.status} · partial reply`}</p>}
                {message.metrics && <p className="message-meta">{message.metrics.elapsed_seconds?.toFixed(1)}s{message.metrics.output_tokens !== undefined && ` · ${message.metrics.output_tokens} output tokens`}</p>}
              </div>
            </li>)}
          </ol>}
        </section>
        <div className="composer-dock">
          {draft?.conflict !== null && draft?.conflict !== undefined && <Alert variant="destructive">
            <AlertTitle>Draft conflict</AlertTitle>
            <AlertDescription>
              <p>Your unsaved edits are retained in the composer. Another tab changed the saved draft; review both before saving.</p>
              <pre className="remote-draft">{draft.conflict || '(Empty saved draft)'}</pre>
              <Button variant="outline" onClick={() => { if (selectedId) library.resolve(selectedId, [draft.text, draft.conflict].filter(Boolean).join('\n')) }}>Keep both drafts</Button>
              <Button variant="outline" onClick={() => { if (selectedId) library.resolve(selectedId, draft.text) }}>Save my reviewed draft</Button>
              <Button variant="ghost" onClick={() => { if (selectedId) library.resolve(selectedId, draft.conflict ?? '') }}>Use saved draft</Button>
            </AlertDescription>
          </Alert>}
          {draft?.error && <Alert><AlertTitle>Draft not saved</AlertTitle><AlertDescription>{draft.error}<Button variant="outline" onClick={() => { if (selectedId) void library.save(selectedId) }}>Retry saving draft</Button></AlertDescription></Alert>}
          <div className="message-composer">
            <label htmlFor="composer" className="sr-only">Your text</label>
            <Textarea id="composer" disabled={!draft} value={draft?.text ?? ''} onChange={(event) => { if (selectedId) library.edit(selectedId, event.target.value) }} onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (canSend) void send() }
            }} placeholder="Message OutLoud" className="composer-input" />
            <div className="composer-toolbar">
              <span className="composer-hint"><AudioLines size={14} />{draft && draft.text !== draft.base ? 'Unsaved changes kept in this tab' : 'Your draft is saved locally'}</span>
              {chat.ownedBusy ? <Button variant="outline" onClick={chat.stop}>Stop generation</Button> : <Button disabled={!canSend} onClick={() => void send()} aria-label="Send message" className="send-button"><ArrowUp size={17} /> Send</Button>}
            </div>
          </div>
          {chat.busy && !chat.ownedBusy && <p role="status" className="capacity-note">This conversation is generating in another tab. Wait for its reply before sending.</p>}
          <div className="recording-row"><RecordingControl enabled={micEnabled} recording={recording} occupied={occupied} pending={dictation.pending} toggle={() => {
            if (recording || selectedId) void dictation.command(recording ? 'stop' : 'start', selectedId ?? dictation.snapshot?.conversation_id ?? '')
          }} /></div>
          {recording && dictation.snapshot?.conversation_id !== selectedId && <p role="status" className="capacity-note">Recording stays bound to its original conversation; switching does not move dictated text.</p>}
          {dictation.snapshot?.capacity.available === 0 && <p role="status" className="capacity-note">Transcription capacity full · wait for a job to finish.</p>}
          <footer className="privacy-footer"><span><Check size={12} /> Audio and conversations stay on this Mac</span><span>Whisper transcription · Gemma chat runs locally</span></footer>
        </div>
      </div>
    </main>
  </div>
}
