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
import { request, type WorkspaceContext } from '@/lib/conversations'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StudyArea } from '@/components/study-area'
import { MaterialsCard } from '@/components/materials-card'
import { ConversationTopicControls } from '@/components/conversation-topic-controls'
import { getStudySession, judgmentLabels, studyJson, type StudySession, type StudyAction } from '@/lib/study'
import { listSubjects, type StudySubject } from '@/lib/study'
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
  const [subjects, setSubjects] = useState<StudySubject[]>([])
  const [questionDraft, setQuestionDraft] = useState<{ messageId: string; text: string } | null>(null)
  const [excludedGuidance, setExcludedGuidance] = useState<Record<string, boolean>>({})
  const dashboardInitialized = useRef(false)
  const refreshSubjects = async () => { try { setSubjects(await listSubjects()) } catch { /* The composer and saved conversations remain usable offline. */ } }
  useEffect(() => {
    let active = true
    void listSubjects().then(saved => {
      if (!active) return
      setSubjects(saved)
      if (saved.length && !dashboardInitialized.current) { setStudyOpen(true); dashboardInitialized.current = true }
    }).catch(() => { dashboardInitialized.current = true })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    if (selectedId) void getStudySession(selectedId).then(session => { if (active) setStudySession(session) }).catch(() => { /* Ordinary chat remains usable if study metadata is unavailable. */ })
    return () => { active = false }
  }, [selectedId, historyRevisions, selected?.focus_topic_id])
  useEffect(() => {
    let active = true
    if (selectedId) void request(`/study/conversations/${encodeURIComponent(selectedId)}/guidance`).then((items: { assistant_message_id: string; excluded: boolean }[]) => {
      if (active) setExcludedGuidance(Object.fromEntries(items.map(item => [item.assistant_message_id, item.excluded])))
    }).catch(() => { /* Guidance labels are a convenience; chat remains available offline. */ })
    return () => { active = false }
  }, [selectedId, historyRevisions])
  const studySession = loadedStudySession?.conversation_id === selectedId && (selected?.focus_topic_id ? loadedStudySession.topic.id === selected.focus_topic_id : !selected?.subject_id) ? loadedStudySession : null
  const selectedSubject = subjects.find(subject => subject.id === selected?.subject_id) ?? null
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
  const createChat = (subjectId: string | null = null, subject?: StudySubject) => {
    if (pendingCreation.current) return pendingCreation.current
    setCreating(true)
    const task = (async () => {
      const topicIds = subject?.topics.filter(topic => topic.active).map(topic => topic.id) ?? []
      const id = await library.create(subjectId, topicIds, topicIds[0] ?? null)
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
  const send = async (retry?: PendingSend, command?: { text: string; action: StudyAction; retryOfMessageId?: string; workspace?: WorkspaceContext }) => {
    if (command ? !canRetry || !selectedId : retry ? !canRetry || (retry.conversationId !== null && retry.conversationId !== selectedId) : !canSend) return
    const text = command?.text ?? retry?.text ?? composerText
    const workspace = retry ? undefined : command?.workspace ?? { mode: selected?.mode ?? 'chat' as const, topic_ids: selected?.topic_ids ?? [], focus_topic_id: selected?.focus_topic_id ?? null }
    const attempt = chat.prepare(selectedId, text, retry, command?.action, workspace)
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
      void chat.send(id, text, () => { if (!command) void library.clearAccepted(id, text) }, attempt.id, attempt.studyAction, workspace ?? (attempt.mode ? { mode: attempt.mode, topic_ids: attempt.topic_ids ?? [], focus_topic_id: attempt.focus_topic_id ?? null } : undefined), command?.retryOfMessageId)
    } finally { if (!started) chat.fail(attempt.id); setSending(false) }
  }
  const saveQuestion = async () => {
    if (!selectedId || !selected?.focus_topic_id || !questionDraft?.text.trim()) return
    try {
      const updated = await request(`/study/conversations/${encodeURIComponent(selectedId)}/question`, studyJson('POST', { assistant_message_id: questionDraft.messageId, topic_id: selected.focus_topic_id, question: questionDraft.text.trim() })) as StudySession
      setStudySession(updated)
      setQuestionDraft(null)
    } catch { /* Keep the chat available if study metadata cannot be saved. */ }
  }
  const toggleGuidance = async (assistantMessageId: string, topicId: string) => {
    if (!selectedId) return
    try {
      if (excludedGuidance[assistantMessageId]) {
        await request(`/study/conversations/${encodeURIComponent(selectedId)}/guidance`, studyJson('POST', { assistant_message_id: assistantMessageId, topic_id: topicId }))
        setExcludedGuidance(previous => ({ ...previous, [assistantMessageId]: false }))
      } else {
        const removed = await request(`/study/conversations/${encodeURIComponent(selectedId)}/guidance/${encodeURIComponent(assistantMessageId)}?topic_id=${encodeURIComponent(topicId)}`, { method: 'DELETE' })
        if (!removed) return
        setExcludedGuidance(previous => ({ ...previous, [assistantMessageId]: true }))
      }
    } catch { /* Keep the current guidance state if metadata cannot be saved. */ }
  }

  return <TooltipProvider><SidebarProvider className="chat-app">
    <AppSidebar library={library} list={list} selectedId={selectedId} subjects={subjects} connected={connected} loading={conversations.loading} creating={creating} onStudy={() => setStudyOpen(true)} onChat={() => setStudyOpen(false)} onMode={mode => { if (selectedId) void library.updateWorkspace(selectedId, { mode }) }} onCreate={(subjectId, subject) => { setStudyOpen(false); void createChat(subjectId, subject) }} />
    <SidebarInset className="chat-main">
      <header className="chat-topbar">
        <div className="chat-heading flex min-w-0 items-center gap-3">
          <SidebarTrigger className="chat-sidebar-toggle" />
          {selected && !studyOpen && <><Separator orientation="vertical" className="h-5" /><div className="workspace-breadcrumb">{selectedSubject?.name ?? 'Unassigned'}{selected.focus_topic_id && <> <span>/</span> {selectedSubject?.topics.find(topic => topic.id === selected.focus_topic_id)?.name ?? 'Topic'}</>}</div></>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {studyOpen && recording && <Button variant="destructive" size="sm" onClick={() => void dictation.command('stop', dictation.snapshot?.conversation_id ?? '')}>Stop recording</Button>}
          <Badge variant={connected ? 'secondary' : 'outline'} role="status" className="connection-status">{connected ? 'Connected · local' : dictation.connection === 'exhausted' ? 'Connection retries exhausted' : dictation.connection === 'retrying' ? 'Reconnecting with backoff…' : 'Connecting…'}</Badge>
          {!connected && <Button variant="ghost" size="icon-sm" aria-label="Reconnect" disabled={dictation.safety === 'stopping'} onClick={dictation.reconnect}><RefreshCw /></Button>}
          {selected && !studyOpen && <ConversationActions key={selected.id} conversation={selected} library={library} enabled={connected} />}
        </div>
      </header>
      {studyOpen ? <StudyArea library={library} connected={connected} sessionId={dictation.sessionId} onOpenConversation={() => { setStudyOpen(false); void refreshSubjects() }} onSubjectsChanged={setSubjects} /> : <div className="workspace-layout">
        <div className="chat-content">
        <ConversationTopicControls conversation={selected} subject={selectedSubject} library={library} disabled={!connected || recording || Boolean(draft?.text.trim())} />
        <div className="session-alerts">
          {studySession && selected?.mode === 'study' && <section className="study-session" aria-label="Study topic"><div className="study-actions"><strong>{judgmentLabels[studySession.topic.judgment]}</strong><Button size="sm" variant="ghost" onClick={() => setStudyOpen(true)}>View study progress</Button></div><p>Exam importance: {studySession.topic.weight === null ? 'Unknown' : `${studySession.topic.weight}%`}</p>{studySession.question && <p>Active question: {studySession.question}</p>}{Boolean(studySession.hinted) && <p>This conversation has received guidance for its current topic.</p>}{['failed', 'cancelled'].includes(selected.messages.at(-1)?.status ?? '') && <Button size="sm" variant="outline" disabled={!canRetry} onClick={() => { const answer = selected.messages.findLast(message => message.role === 'user'); if (answer) { const context = answer.turn_context; const action = ['answer', 'explain', 'practice', 'finish'].includes(context?.action ?? '') ? context!.action as StudyAction : studySession.last_action; void send(undefined, { text: answer.content, action, retryOfMessageId: context ? answer.id : undefined, workspace: { mode: context?.mode ?? 'study', topic_ids: context?.topic_ids ?? selected.topic_ids, focus_topic_id: context?.focus_topic_id ?? selected.focus_topic_id } }) } }}>Retry feedback</Button>}</section>}
          {dictation.safety !== 'none' && <Alert variant={dictation.safety === 'unconfirmed' ? 'destructive' : 'default'}>
            <AlertTitle>{dictation.safety === 'stopping' ? 'Stopping recording safely…' : dictation.safety === 'unconfirmed' ? 'Recording stop is unconfirmed' : 'Backend confirmed this tab’s recording stopped'}</AlertTitle>
            <AlertDescription>{dictation.safety === 'unconfirmed' ? 'Check or restart the backend. Reconnect will verify this client has released capture before starting a new session.' : 'Checking this tab’s capture only; other tabs may stay connected.'}</AlertDescription>
          </Alert>}
          {recovered.length > 0 && <Collapsible className="recovered-drafts"><CollapsibleTrigger asChild><Button variant="outline" className="h-auto w-full justify-between whitespace-normal text-left">Recovered unsaved drafts from unavailable conversations<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent>{recovered.map(([id, item]) => <Card key={id} className="mt-2"><CardContent><p>Conversation {id} · copy this text to a new chat to keep working.</p><pre>{item.text}</pre></CardContent></Card>)}</CollapsibleContent></Collapsible>}
        </div>
        <section className="conversation" aria-label="Conversation">
          {!chat.messages.length ? <Empty className="empty-conversation">
            <EmptyHeader className="max-w-md">
              <EmptyTitle><h1 className="text-2xl font-semibold tracking-tight">{selected?.mode === 'study' ? 'What would you like to work on?' : 'What can I help with?'}</h1></EmptyTitle>
              <EmptyDescription>Ask a question, request an explanation, or share your thinking. Speak naturally or type a message.</EmptyDescription>
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
                  {chat.messages.map((message, index) => {
                    const turnContext = message.role === 'assistant' ? chat.messages.slice(0, index).findLast(item => item.role === 'user')?.turn_context : undefined
                    const guidedTopic = turnContext?.mode === 'chat' && turnContext.focus_topic_id ? selectedSubject?.topics.find(topic => topic.id === turnContext.focus_topic_id) : undefined
                    return <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}><div className="chat-message-with-guidance"><ChatMessage message={message} onRetry={message.pendingSend ? () => { void send(message.pendingSend) } : undefined} retryDisabled={!canRetry} />{message.role === 'assistant' && message.status === 'complete' && selected?.mode === 'study' && selectedSubject && !studySession?.question && turnContext?.mode === 'study' && turnContext.focus_topic_id === selected.focus_topic_id && <div className="study-question-editor">{questionDraft?.messageId === message.id ? <><Label htmlFor={`study-question-${message.id}`}>Save this reply as the active Study question</Label><textarea id={`study-question-${message.id}`} value={questionDraft.text} onChange={event => setQuestionDraft({ messageId: message.id, text: event.target.value })} rows={3} /><div><Button size="sm" onClick={() => void saveQuestion()}>Save question</Button><Button size="sm" variant="ghost" onClick={() => setQuestionDraft(null)}>Cancel</Button></div></> : <Button variant="ghost" size="sm" onClick={() => setQuestionDraft({ messageId: message.id, text: message.content })}>Use reply as Study question</Button>}</div>}{message.role === 'assistant' && message.content.trim() && message.status !== 'streaming' && guidedTopic && <div className="chat-guidance-status"><span>{excludedGuidance[message.id] ? 'Not counted as Study guidance' : `Counts as Study guidance for ${guidedTopic.name}`}</span><Button variant="ghost" size="sm" onClick={() => void toggleGuidance(message.id, guidedTopic.id)}>{excludedGuidance[message.id] ? 'Count as guidance' : 'Exclude as guidance'}</Button></div>}</div></MessageScrollerItem>
                  })}
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
        </div>
        <MaterialsCard key={`${selectedSubject?.id ?? 'none'}:${selectedSubject?.uploads.find(upload => upload.role === 'reference')?.text ?? ''}`} subject={selectedSubject} onOpenStudy={() => setStudyOpen(true)} onSubjectsChanged={setSubjects} />
      </div>}
    </SidebarInset>
  </SidebarProvider></TooltipProvider>
}
