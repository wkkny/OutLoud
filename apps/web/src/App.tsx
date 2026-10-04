import { useEffect, useRef, useState } from 'react'
import { Toaster, createToastManager } from '@/components/ui/toast'
import { ArrowUp, ChevronDown, RefreshCw, Square } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { ChatMessage } from '@/components/chat-message'
import { ChatSuggestions } from '@/components/chat-suggestions'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { RecordingControl } from '@/components/recording-control'
import { useDictation } from '@/hooks/use-dictation'
import { useNotifications } from '@/hooks/use-notifications'
import { useConversations } from '@/hooks/use-conversations'
import { useChat } from '@/hooks/use-chat'
import { readUnscopedDraft, writeUnscopedDraft, type PendingSend } from '@/lib/chat-recovery'
import { AppSidebar } from '@/components/app-sidebar'
import { ConversationActions } from '@/components/conversation-actions'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StudyArea } from '@/components/study-area'
import { getStudySession, judgmentLabels, type StudySession, type StudyAction } from '@/lib/study'
import './chat-ui.css'

export default function App() {
  const [toastManager] = useState(createToastManager)
  return <Toaster toastManager={toastManager}><ChatApp /></Toaster>
}

function ChatApp() {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const conversations = useConversations()
  const dictation = useDictation(conversations.library)
  const { library, selectedId, list, details, historyRevisions, drafts } = conversations
  const selected = selectedId ? details[selectedId] : undefined
  const draft = selectedId ? drafts[selectedId] : undefined
  const chat = useChat(dictation.sessionId, selectedId, details, historyRevisions, library)
  const [studyOpen, setStudyOpen] = useState(false)
  const [loadedStudySession, setStudySession] = useState<StudySession | null>(null)
  useEffect(() => {
    let active = true
    if (selectedId) void getStudySession(selectedId).then(session => { if (active) setStudySession(session) }).catch(() => { /* Ordinary chat remains usable if study metadata is unavailable. */ })
    return () => { active = false }
  }, [selectedId, historyRevisions])
  const studySession = loadedStudySession?.conversation_id === selectedId ? loadedStudySession : null
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const pendingCreation = useRef<Promise<string | null> | null>(null)
  const [unscopedDraft, setUnscopedDraft] = useState(readUnscopedDraft)
  const latestUnscopedDraft = useRef(unscopedDraft)
  const editUnscopedDraft = (text: string) => {
    writeUnscopedDraft(text)
    latestUnscopedDraft.current = text
    setUnscopedDraft(text)
  }
  useNotifications({ ...dictation, selectedId, library, libraryError: conversations.error, recordingError: dictation.error, chatError: chat.error ?? null, capacityFull: dictation.snapshot ? dictation.snapshot.capacity.available === 0 : null, draftError: draft?.conflict === null ? draft.error : null })
  const connected = dictation.connection === 'connected'
  const recording = dictation.snapshot?.capture_owned ?? false
  const occupied = Boolean(dictation.snapshot?.recording && !recording)
  const micEnabled = connected && dictation.safety === 'none' && (recording || (!creating && Boolean(dictation.snapshot?.ready && dictation.snapshot.capacity.available > 0)))
  const composerText = draft ? [draft.text, unscopedDraft].filter(Boolean).join('\n') : unscopedDraft
  const hasUnsavedDraft = Boolean(unscopedDraft || (draft && draft.text !== draft.base))
  const canSend = connected && Boolean(composerText.trim()) && (!selectedId || Boolean(draft)) && (!draft || draft.conflict === null) && !chat.busy && !sending && !creating
  const canRetry = connected && (!selectedId || Boolean(draft)) && (!draft || draft.conflict === null) && !chat.busy && !sending && !creating
  const recovered = Object.entries(drafts).filter(([id, item]) => !list.some((conversation) => conversation.id === id) && item.text !== item.base)
  const createChat = () => {
    if (pendingCreation.current) return pendingCreation.current
    setCreating(true)
    const task = (async () => {
      const id = await library.create()
      if (!mounted.current) return null
      if (id) {
        if (latestUnscopedDraft.current) library.edit(id, latestUnscopedDraft.current)
        editUnscopedDraft('')
      }
      return id
    })().finally(() => { pendingCreation.current = null; setCreating(false) })
    pendingCreation.current = task
    return task
  }
  const ensureConversation = async () => selectedId ?? createChat()
  const send = async (retry?: PendingSend, command?: { text: string; action: StudyAction }) => {
    if (command ? !canRetry || !selectedId : retry ? !canRetry || (retry.conversationId !== null && retry.conversationId !== selectedId) : !canSend) return
    const text = command?.text ?? retry?.text ?? composerText
    const attempt = chat.prepare(selectedId, text, retry, command?.action)
    setSending(true)
    let started = false
    try {
      if (!command && selectedId && unscopedDraft) {
        library.edit(selectedId, composerText)
        editUnscopedDraft('')
      }
      const id = await ensureConversation()
      if (!id) return
      chat.attach(attempt.id, id)
      if (!await library.save(id) || !mounted.current) return
      // An append/conflict during saving must be reviewed before sending.
      if (!retry && !command && library.getSnapshot().drafts[id]?.text !== text) return
      started = true
      void chat.send(id, text, () => { if (!command) void library.clearAccepted(id, text) }, attempt.id, attempt.studyAction)
    } finally { if (!started) chat.fail(attempt.id); setSending(false) }
  }

  return <TooltipProvider><SidebarProvider className="chat-app">
    <AppSidebar library={library} list={list} selectedId={selectedId} connected={connected} loading={conversations.loading} creating={creating} onStudy={() => setStudyOpen(true)} onChat={() => setStudyOpen(false)} onCreate={() => { setStudyOpen(false); void createChat() }} />
    <SidebarInset className="chat-main">
      <header className="chat-topbar">
        <div className="chat-heading flex min-w-0 items-center gap-3">
          <SidebarTrigger className="chat-sidebar-toggle" />
          {selected && !studyOpen && <><Separator orientation="vertical" className="h-5" /><div className="truncate text-sm font-medium">{selected.title}</div></>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {studyOpen && recording && <Button variant="destructive" size="sm" onClick={() => void dictation.command('stop', dictation.snapshot?.conversation_id ?? '')}>Stop recording</Button>}
          <Badge variant={connected ? 'secondary' : 'outline'} role="status" className="connection-status">{connected ? 'Connected · local' : dictation.connection === 'exhausted' ? 'Connection retries exhausted' : dictation.connection === 'retrying' ? 'Reconnecting with backoff…' : 'Connecting…'}</Badge>
          {!connected && <Button variant="ghost" size="icon-sm" aria-label="Reconnect" disabled={dictation.safety === 'stopping'} onClick={dictation.reconnect}><RefreshCw /></Button>}
          {selected && !studyOpen && <ConversationActions key={selected.id} conversation={selected} library={library} enabled={connected} />}
        </div>
      </header>
      {studyOpen ? <StudyArea library={library} connected={connected} sessionId={dictation.sessionId} onOpenConversation={() => setStudyOpen(false)} /> : <div className="chat-content">
        <div className="session-alerts">
          {studySession && <section className="study-session" aria-label="Study topic"><div className="study-actions"><strong>{studySession.subject.name} · {studySession.topic.name}</strong><Button size="sm" variant="ghost" onClick={() => setStudyOpen(true)}>View study progress</Button></div><p>{judgmentLabels[studySession.topic.judgment]} · Exam importance: {studySession.topic.weight === null ? 'Unknown' : `${studySession.topic.weight}%`}</p><p>{studySession.finished ? 'Study summary saved. Choose a topic or practice again when ready.' : studySession.question}</p>{Boolean(studySession.hinted) && <p>Answer after guidance · a fresh independent question is needed for reassessment.</p>}<div className="study-actions"><Button size="sm" variant="outline" disabled={!canRetry} onClick={() => void send(undefined, { text: 'Explain the gap in my understanding.', action: 'explain' })}>Explain this</Button><Button size="sm" variant="outline" disabled={!canRetry} onClick={() => void send(undefined, { text: 'Give me a fresh practice question.', action: 'practice' })}>Practice this</Button><Button size="sm" variant="ghost" onClick={() => setStudyOpen(true)}>Move on</Button><Button size="sm" variant="ghost" disabled={!canRetry} onClick={() => void send(undefined, { text: 'Summarize my study progress and revision priorities.', action: 'finish' })}>Finish studying</Button>{['failed', 'cancelled'].includes(selected?.messages.at(-1)?.status ?? '') && <Button size="sm" variant="outline" disabled={!canRetry} onClick={() => { const answer = selected?.messages.findLast(message => message.role === 'user'); if (answer) void send(undefined, { text: answer.content, action: studySession.last_action }) }}>Retry feedback</Button>}</div></section>}
          {dictation.safety !== 'none' && <Alert variant={dictation.safety === 'unconfirmed' ? 'destructive' : 'default'}>
            <AlertTitle>{dictation.safety === 'stopping' ? 'Stopping recording safely…' : dictation.safety === 'unconfirmed' ? 'Recording stop is unconfirmed' : 'Backend confirmed this tab’s recording stopped'}</AlertTitle>
            <AlertDescription>{dictation.safety === 'unconfirmed' ? 'Check or restart the backend. Reconnect will verify this client has released capture before starting a new session.' : 'Checking this tab’s capture only; other tabs may stay connected.'}</AlertDescription>
          </Alert>}
          {recovered.length > 0 && <Collapsible className="recovered-drafts"><CollapsibleTrigger asChild><Button variant="outline" className="h-auto w-full justify-between whitespace-normal text-left">Recovered unsaved drafts from unavailable conversations<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent>{recovered.map(([id, item]) => <Card key={id} className="mt-2"><CardContent><p>Conversation {id} · copy this text to a new chat to keep working.</p><pre>{item.text}</pre></CardContent></Card>)}</CollapsibleContent></Collapsible>}
        </div>
        <section className="conversation" aria-label="Conversation">
          {!chat.messages.length ? <Empty className="empty-conversation">
            <EmptyHeader className="max-w-md">
              <EmptyTitle><h1 className="text-2xl font-semibold tracking-tight">{studySession ? `Let's study ${studySession.topic.name}` : 'What can I help with?'}</h1></EmptyTitle>
              <EmptyDescription>{studySession ? 'Start with your own explanation. Speak or type, review your answer, then send it.' : 'Speak naturally or type a message. Review your words, then send them to Gemma.'}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="max-w-md">{!studySession && <ChatSuggestions enabled={Boolean(!composerText && (!selectedId || draft) && (!draft || draft.conflict === null) && connected && !creating)} onSelect={(prompt) => {
              if (composerText || (draft && draft.conflict !== null)) return
              if (selectedId && draft) library.edit(selectedId, prompt)
              else if (!selectedId) editUnscopedDraft(prompt)
              document.getElementById('composer')?.focus()
            }} />}</EmptyContent>
          </Empty> : <MessageScrollerProvider key={selectedId}>
            <MessageScroller>
              <MessageScrollerViewport aria-label="Conversation messages">
                <MessageScrollerContent className="message-list">
                  {chat.messages.map((message) => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}><ChatMessage message={message} onRetry={message.pendingSend ? () => { void send(message.pendingSend) } : undefined} retryDisabled={!canRetry} /></MessageScrollerItem>)}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>}
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
          <Label htmlFor="composer" className="sr-only">Your text</Label>
          <InputGroup className="message-composer">
            <InputGroupTextarea id="composer" disabled={Boolean(selectedId && !draft)} value={composerText} onChange={(event) => {
              if (selectedId && draft) { library.edit(selectedId, event.target.value); editUnscopedDraft('') }
              else if (!selectedId) editUnscopedDraft(event.target.value)
            }} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) { event.preventDefault(); if (canSend) void send() }
            }} placeholder="Send a message…" className="composer-input" aria-describedby={hasUnsavedDraft ? 'draft-status' : undefined} />
            <InputGroupAddon align="block-end" className="composer-toolbar">
              <span className="composer-model">Gemma 3:4b</span>
              <RecordingControl enabled={micEnabled} recording={recording} level={dictation.level} occupied={occupied} pending={dictation.pending} toggle={() => {
                if (recording) { void dictation.command('stop', selectedId ?? dictation.snapshot?.conversation_id ?? ''); return }
                void (async () => {
                  const id = await ensureConversation()
                  if (!id) return
                  void dictation.command('start', id)
                })()
              }} />
              {chat.ownedBusy ? <InputGroupButton variant="outline" size="icon-sm" className="ml-auto" onClick={chat.stop} aria-label="Stop generation"><Square /></InputGroupButton> : <InputGroupButton variant="default" size="icon-sm" className="ml-auto" disabled={!canSend} onClick={() => void send()} aria-label="Send message"><ArrowUp /></InputGroupButton>}
            </InputGroupAddon>
          </InputGroup>
          <div className="composer-notes">
            {hasUnsavedDraft && <span id="draft-status" className="composer-hint">Unsaved changes kept in this tab</span>}
            <p className="send-shortcut"><Kbd>Enter</Kbd><span>to send · Shift+Enter for a new line</span></p>
          </div>
          {chat.busy && !chat.ownedBusy && <p role="status" className="capacity-note">This conversation is generating in another tab. Wait for its reply before sending.</p>}
          {recording && dictation.snapshot?.conversation_id !== selectedId && <p role="status" className="capacity-note">Recording stays bound to its original conversation; switching does not move dictated text.</p>}
        </div>
      </div>}
    </SidebarInset>
  </SidebarProvider></TooltipProvider>
}
