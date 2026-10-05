// THROWAWAY: subject folders and a shared Study/Chat workspace on ?prototype=study-release&variant=A|B|C.
// In-memory demo only. No backend, models, microphone, storage or real assessment.
import { useEffect, useState } from 'react'
import { Popover } from 'radix-ui'
import { ArrowDownToLine, ArrowLeft, ArrowRight, AudioLines, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, FileText, Folder, FolderPlus, Menu, Mic, Plus, Search, Settings2, Square, SquarePen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import './prototype-study-release.css'

type Variant = 'A' | 'B' | 'C'
type Mode = 'Study' | 'Chat'
type Readiness = 'ready' | 'missing' | 'downloading' | 'error' | 'offline'
type Topic = { name: string; status: 'Needs revision' | 'Partial understanding' | 'Not assessed' | 'Demonstrated understanding'; weight: number | null; evidence: number }
type Subject = { name: string; topics: Topic[]; reference: string; approved: boolean }
type Turn = { id: string; mode: Mode; topic: string | null; question: string; requestedQuestion?: string; answer: string; reply: string; assisted: boolean; provisional: boolean; failed: boolean; guidanceTopics: string[] }
type Conversation = { id: string; subject: string; title: string; saved: boolean; mode: Mode; selectedTopics: string[]; activeTopic: string | null; questions: Record<string, string>; assistedTopics: string[]; draft: string; turns: Turn[]; finished: boolean }
const variants: Record<Variant, string> = { A: 'Study dashboard', B: 'Revision queue', C: 'Subject notebook' }
const dbms = 'Database Management Systems'
const os = 'Operating Systems'
const sourceText = 'A relation is in 3NF when, for each non-trivial functional dependency X → A, X is a superkey or A is a prime attribute. Removing transitive dependencies can prevent update anomalies.'
const initialSubjects: Subject[] = [
  { name: dbms, reference: sourceText, approved: true, topics: [
    { name: 'Normalization', status: 'Needs revision', weight: 20, evidence: 2 },
    { name: 'Transactions', status: 'Partial understanding', weight: 25, evidence: 1 },
    { name: 'Indexing', status: 'Not assessed', weight: null, evidence: 0 },
    { name: 'Relational algebra', status: 'Demonstrated understanding', weight: 15, evidence: 3 },
  ] },
  { name: os, reference: '', approved: false, topics: [
    { name: 'Process scheduling', status: 'Not assessed', weight: null, evidence: 0 },
    { name: 'Deadlocks', status: 'Partial understanding', weight: 15, evidence: 1 },
  ] },
]
const explanationFor = (topic: string) => topic === 'Normalization'
  ? 'For example, Employee → Department → Department name is a transitive dependency. Store department details separately to avoid updating the same name in every employee row.'
  : `Demo guidance for ${topic.toLowerCase()}: identify the main idea, then connect it to a concrete example. No model was called.`
const makeConversation = (id: string, subject: string, title: string, selectedTopics: string[], saved = true): Conversation => ({
  id, subject, title, saved, mode: selectedTopics.length ? 'Study' : 'Chat', selectedTopics,
  activeTopic: selectedTopics[0] ?? null, questions: {},
  assistedTopics: [], draft: '', turns: [], finished: false,
})
const initialConversations = [
  makeConversation('normalization', dbms, 'Normalization practice', ['Normalization']),
  makeConversation('exam', dbms, 'Exam revision', ['Normalization', 'Transactions']),
  makeConversation('scheduling', os, 'Scheduling notes', ['Process scheduling']),
]
const statusClass = (status: Topic['status']) => status === 'Needs revision' ? 'needs' : status === 'Demonstrated understanding' ? 'demonstrated' : 'neutral'

export default function StudyReleasePrototype() {
  const initialVariant = new URLSearchParams(location.search).get('variant') as Variant
  const [variant, setVariant] = useState<Variant>(initialVariant in variants ? initialVariant : 'B')
  const [subjects, setSubjects] = useState(initialSubjects)
  const [subjectName, setSubjectName] = useState(dbms)
  const subject = subjects.find(item => item.name === subjectName)!
  const [subjectFilter, setSubjectFilter] = useState(dbms)
  const [allSubjectsOpen, setAllSubjectsOpen] = useState(false)
  const [subjectPickerOpen, setSubjectPickerOpen] = useState(false)
  const [subjectSearch, setSubjectSearch] = useState('')
  const [sidebarSearch, setSidebarSearch] = useState('')
  const [conversations, setConversations] = useState(initialConversations)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const current = conversations.find(item => item.id === conversationId)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [readiness, setReadiness] = useState<Readiness>('ready')
  const [progress, setProgress] = useState(0)
  const [setup, setSetup] = useState(false)
  const [newSubject, setNewSubject] = useState(false)
  const [newSubjectName, setNewSubjectName] = useState('')
  const [newTopics, setNewTopics] = useState('')
  const [recording, setRecording] = useState(false)
  const [provisional, setProvisional] = useState(false)
  const [feedbackFailed, setFeedbackFailed] = useState(false)
  const [details, setDetails] = useState<'materials' | 'evidence' | null>(null)
  const [topicPicker, setTopicPicker] = useState(false)
  const [topicSelection, setTopicSelection] = useState<string[]>([])
  const ready = readiness === 'ready'
  const modelMessage = readiness === 'offline' ? 'Connection lost. Your draft stays here.' : readiness === 'downloading' ? `Downloading models · ${progress}%` : readiness === 'error' ? 'Download interrupted. Retry in settings.' : 'Install the local model to continue.'
  const subjectConversations = conversations.filter(item => item.subject === subject.name && item.saved)
  const nextTopic = subject.topics[0]
  const assessed = subject.topics.filter(item => item.evidence > 0).length
  const demonstrated = subject.topics.filter(item => item.status === 'Demonstrated understanding').length
  const state = { variant, subject, subjectFilter, conversationId, conversations, readiness, progress, recording, provisional, feedbackFailed }
  const updateConversation = (id: string, update: (value: Conversation) => Conversation) => setConversations(previous => previous.map(item => item.id === id ? update(item) : item))
  const updateCurrent = (update: (value: Conversation) => Conversation) => { if (current) updateConversation(current.id, update) }
  const openSubject = (name: string) => { setSubjectName(name); setSubjectFilter(name); setAllSubjectsOpen(false); setConversationId(null); setSidebarOpen(false); setSubjectPickerOpen(false); setSubjectSearch('') }
  const openConversation = (value: Conversation) => { setSubjectName(value.subject); setAllSubjectsOpen(false); setConversationId(value.id); setSidebarOpen(false) }
  const showAllSubjects = () => { setSubjectFilter('all'); setAllSubjectsOpen(true); setConversationId(null); setSidebarOpen(false); setSubjectPickerOpen(false); setSubjectSearch('') }
  const createConversation = (name: string, topic?: string) => {
    const pending = conversations.find(item => item.subject === name && !item.saved)
    if (pending) { openConversation(pending); return }
    const selected = topic ?? subjects.find(item => item.name === name)?.topics[0]?.name
    const value = makeConversation(crypto.randomUUID(), name, 'New conversation', selected ? [selected] : [], false)
    setConversations(previous => [...previous, value]); openConversation(value)
  }
  const studyTopic = (topic: string) => {
    const saved = subjectConversations.find(item => item.activeTopic === topic)
    if (saved) openConversation(saved)
    else createConversation(subject.name, topic)
  }
  const changeVariant = (next: Variant) => {
    setVariant(next)
    const url = new URL(location.href); url.searchParams.set('variant', next); history.replaceState(null, '', url)
  }
  const cycle = (delta: number) => {
    const keys: Variant[] = ['A', 'B', 'C']; changeVariant(keys[(keys.indexOf(variant) + delta + keys.length) % keys.length])
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('input, textarea, select, button, [role="dialog"], [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(event.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (readiness !== 'downloading') return
    const timer = setInterval(() => setProgress(previous => Math.min(previous + 5, 100)), 250)
    return () => clearInterval(timer)
  }, [readiness])

  // Guidance classification is a deliberately small demo heuristic, not an assessment model.
  const guidanceTopicsFor = (value: Conversation, text: string) => {
    if (!/\b(explain|hint|help|teach|example|why|how)\b/i.test(text)) return []
    const mentioned = value.selectedTopics.filter(topic => text.toLowerCase().includes(topic.toLowerCase()))
    return mentioned.length ? mentioned : value.activeTopic ? [value.activeTopic] : []
  }
  const addTurn = (value: Conversation, text: string, incomingGuidance: string[] = []) => {
    const isStudy = value.mode === 'Study'
    const topic = isStudy ? value.activeTopic : null
    const question = topic ? value.questions[topic] ?? '' : ''
    // Demo phrase matcher only. Production must interpret conversational intent, not copy this regex.
    const asksForQuestion = isStudy && !!topic && /\b(quiz me|test me|ask me (?:a|another) question|give me (?:a|another) question|let'?s practi[cs]e)\b/i.test(text)
    const questionCount = value.turns.filter(turn => turn.requestedQuestion && turn.topic === topic).length
    const requestedQuestion = asksForQuestion ? questionCount % 2 ? `What would change in a different example of ${topic?.toLowerCase()}? Explain your reasoning.` : `Can you walk through a simple example of ${topic?.toLowerCase()}?` : ''
    const guidanceTopics = requestedQuestion ? [] : incomingGuidance
    const isAssessment = isStudy && !!question && !requestedQuestion && guidanceTopics.length === 0
    const answerIndex = value.turns.findLastIndex(turn => turn.topic === topic && !!turn.question && turn.question === question && !turn.failed)
    const helpIndex = value.turns.findLastIndex(turn => !!topic && turn.guidanceTopics.includes(topic))
    const assistance = requestedQuestion && answerIndex >= 0 && answerIndex > helpIndex ? value.assistedTopics.filter(item => item !== topic) : value.assistedTopics
    const turn: Turn = {
      id: crypto.randomUUID(), mode: value.mode, topic, question: isAssessment ? question : '', requestedQuestion, answer: text,
      reply: requestedQuestion || (isAssessment ? `Demo feedback for ${topic}: your answer is retained. A real assessment would check its claims against applicable approved references.`
        : guidanceTopics.length ? guidanceTopics.map(explanationFor).join('\n\n') : `Demo ${value.mode} reply in ${subject.name}. This discussion is not assessment evidence. No model was called.`),
      assisted: isAssessment && !!topic && assistance.includes(topic), provisional: provisional || !subject.approved || subject.name !== dbms || subject.reference !== sourceText || topic !== 'Normalization',
      failed: isAssessment && feedbackFailed, guidanceTopics,
    }
    return {
      ...value, saved: true, title: value.saved ? value.title : isAssessment ? `${topic} practice` : text.slice(0, 42),
      turns: [...value.turns, turn], finished: isStudy ? false : value.finished,
      questions: requestedQuestion && topic ? { ...value.questions, [topic]: requestedQuestion } : value.questions,
      // Keep assistance on retries/repeated answers. Only a fresh requested attempt can reset it.
      assistedTopics: [...new Set([...assistance, ...guidanceTopics])],
    }
  }
  const send = () => {
    if (!current || !ready || recording || !current.draft.trim() || (current.mode === 'Study' && !current.activeTopic) || (current.finished && current.mode === 'Study')) return
    updateCurrent(value => ({ ...addTurn(value, value.draft, value.mode === 'Chat' || !value.activeTopic || !value.questions[value.activeTopic] || /\b(explain|hint|help|teach)\b/i.test(value.draft) ? guidanceTopicsFor(value, value.draft) : []), draft: '' }))
  }
  const explain = () => {
    if (!current?.activeTopic || !ready || recording) return
    const topic = current.activeTopic
    updateCurrent(value => addTurn({ ...value, mode: 'Chat' }, `Explain ${topic.toLowerCase()}.`, [topic]))
  }
  const toggleRecording = () => {
    if (recording) {
      setRecording(false)
      updateCurrent(value => ({ ...value, draft: [value.draft, `My explanation of ${value.activeTopic?.toLowerCase() ?? 'this subject'} starts with a concrete example.`].filter(Boolean).join('\n') }))
    } else if (ready && current && !(current.finished && current.mode === 'Study')) setRecording(true)
  }
  const applyTopics = () => {
    if (!current || recording) return
    const nextActive = current.activeTopic && topicSelection.includes(current.activeTopic) ? current.activeTopic : topicSelection[0] ?? null
    if (current.draft.trim() && nextActive !== current.activeTopic) return
    updateCurrent(value => ({ ...value, selectedTopics: topicSelection, activeTopic: nextActive }))
    setTopicPicker(false)
  }
  const status = (item: Topic) => <span className={`prototype-status ${statusClass(item.status)}`}>{item.status}</span>
  const warning = <p className="prototype-inline-warning">{modelMessage} <button onClick={() => setSetup(true)}>Open settings</button></p>
  const materialButton = <Button variant="ghost" onClick={() => setDetails('materials')}><FileText size={16} /> Materials</Button>
  const materialsCard = <aside className="prototype-material-card prototype-permanent-materials" aria-label="Syllabus and references">
    <div className="prototype-material-title"><FileText size={17} /><h2>Syllabus and references</h2></div>
    <p>Reviewed course references stay close while you study or chat. Approved excerpts can support assessments.</p>
    <label htmlFor="prototype-reference-card">Reference text</label>
    <Textarea id="prototype-reference-card" value={subject.reference} onChange={event => setSubjects(previous => previous.map(item => item.name === subject.name ? { ...item, reference: event.target.value, approved: false } : item))} placeholder="Add a syllabus excerpt or course reference…" />
    <small>{subject.approved ? 'Approved · demo source' : subject.reference.trim() ? 'Pending review' : 'No reviewed reference yet'}</small>
    <Button onClick={() => setSubjects(previous => previous.map(item => item.name === subject.name ? { ...item, approved: true } : item))} disabled={!subject.reference.trim()}>{subject.approved ? 'Reference approved' : 'Approve reviewed excerpt'}</Button>
  </aside>
  const stats = <div className="prototype-queue-summary"><span><strong>{assessed} of {subject.topics.length}</strong> assessed</span><span><strong>{demonstrated}</strong> understanding demonstrated</span></div>
  const next = <section className="prototype-next-topic"><h2>{nextTopic?.name ?? 'Add your first topic'}</h2>{nextTopic && <p>{nextTopic.name === 'Normalization' ? 'Revisit transitive dependencies.' : nextTopic.evidence ? 'Continue your conversation.' : 'Explore this topic.'}</p>}<Button onClick={() => nextTopic && studyTopic(nextTopic.name)} disabled={!ready || !nextTopic}>{nextTopic?.evidence ? 'Continue studying' : 'Study topic'} <ArrowRight size={16} /></Button>{!ready && warning}</section>
  const rows = <div className="prototype-topic-list">{subject.topics.map((item, index) => <button key={item.name} onClick={() => studyTopic(item.name)} disabled={!ready} className="prototype-topic-row"><span className="prototype-priority">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.name}</strong><small>{item.weight === null ? 'Exam importance unknown' : `${item.weight}% exam importance`} · {item.evidence ? `${item.evidence} evidence ${item.evidence === 1 ? 'record' : 'records'}` : 'No assessment evidence yet'}</small></div>{status(item)}<ChevronRight size={16} /></button>)}</div>
  const homeContent = <>
    <header className="prototype-queue-heading"><h1>{subject.name}</h1>{variant !== 'B' && materialButton}</header>{stats}
    {variant === 'A' ? <div className="prototype-dashboard-grid">{next}<section className="prototype-material-card"><h3>Conversations</h3>{subjectConversations.map(item => <Button key={item.id} variant="ghost" onClick={() => openConversation(item)}>{item.title}<ArrowRight size={14} /></Button>)}</section></div> : next}
    <h2 className="prototype-small-heading">{variant === 'C' ? 'Syllabus' : 'Revision queue'}</h2>{rows}
    {variant === 'C' && <section className="prototype-source"><h3>Subject reference</h3><p>{subject.reference || 'No approved reference yet.'}</p>{materialButton}</section>}
  </>
  const home = variant === 'B' ? <div className="prototype-revision-layout"><div className="prototype-revision-main">{homeContent}</div>{materialsCard}</div> : homeContent
  const allSubjects = <section className="prototype-all-subjects"><header><div><h1>All subjects</h1><p>Choose a subject to continue studying.</p></div><Button onClick={() => setNewSubject(true)}><Plus size={16} /> New subject</Button></header><div className="prototype-all-subject-grid">{subjects.map(item => <button key={item.name} className="prototype-all-subject-card" onClick={() => openSubject(item.name)}><span className="prototype-subject-icon"><Folder size={18} /></span><span className="prototype-all-subject-copy"><strong>{item.name}</strong><small>{item.topics.length} {item.topics.length === 1 ? 'topic' : 'topics'} · {conversations.filter(value => value.subject === item.name && value.saved).length} conversations</small></span><ChevronRight size={17} /></button>)}</div></section>
  const topicChangeBlocked = !!current && !!current.draft.trim() && !!current.activeTopic && !topicSelection.includes(current.activeTopic)
  const studyTurn = current?.turns.filter(turn => turn.mode === 'Study' && turn.question).at(-1)

  return <div className={`study-release-prototype variant-${variant}`}>
    <div className="prototype-banner">Prototype · demo data and actions · resets on reload</div>
    <div className="prototype-mobile-nav"><Button variant="ghost" onClick={() => setSidebarOpen(true)} aria-label="Open subjects"><Menu size={18} /></Button><strong>OutLoud</strong></div>
    {sidebarOpen && <button className="prototype-sidebar-scrim" aria-label="Dismiss subjects" onClick={() => setSidebarOpen(false)} />}
    <div className="prototype-shell">
      <aside className={`prototype-sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Subjects and conversations">
        <Button variant="ghost" className="prototype-sidebar-close" aria-label="Close subjects" onClick={() => setSidebarOpen(false)}><X size={17} /></Button>
        <button className="prototype-brand" onClick={showAllSubjects} disabled={recording}><AudioLines size={23} /><strong>OutLoud</strong></button>
        <div className="prototype-sidebar-tools">
          <label className="prototype-sidebar-search"><Search size={16} /><input type="search" value={sidebarSearch} onChange={event => setSidebarSearch(event.target.value)} placeholder="Search" aria-label="Search conversations" /></label>
          <Popover.Root open={subjectPickerOpen} onOpenChange={open => { setSubjectPickerOpen(open); if (!open) setSubjectSearch('') }}>
            <Popover.Trigger asChild><button className="prototype-sidebar-tool-button" disabled={recording} aria-label={`Select subject, current subject ${subjectFilter === 'all' ? 'All subjects' : subjectFilter}`} title="Select subject"><span className="prototype-subject-avatar">{subjectFilter === 'all' ? 'All' : (subjects.find(item => item.name === subjectFilter)?.name ?? '').slice(0, 2).toUpperCase()}</span></button></Popover.Trigger>
            <Popover.Content className="prototype-subject-picker" align="start" sideOffset={6} collisionPadding={12} aria-label="Select a subject">
              <label className="prototype-subject-search"><Search size={16} /><Input autoFocus value={subjectSearch} onChange={event => setSubjectSearch(event.target.value)} placeholder="Search subjects…" aria-label="Search subjects" /></label>
              <button className={`prototype-subject-picker-all ${subjectFilter === 'all' ? 'active' : ''}`} onClick={showAllSubjects}><Folder size={16} /><span>All subjects</span></button>
              <div className="prototype-subject-picker-list">{subjects.filter(item => item.name.toLowerCase().includes(subjectSearch.trim().toLowerCase())).map(item => <div key={item.name} className={`prototype-subject-option ${subjectFilter === item.name ? 'active' : ''}`}>
                <button className="prototype-subject-option-main" onClick={() => openSubject(item.name)}><span className="prototype-subject-icon"><Folder size={16} /></span><span>{item.name}</span></button>
                <button className="prototype-subject-option-settings" aria-label={`Manage ${item.name}`} title={`Manage ${item.name}`} onClick={() => openSubject(item.name)}><Settings2 size={16} /></button>
              </div>)}{!subjects.some(item => item.name.toLowerCase().includes(subjectSearch.trim().toLowerCase())) && <p className="prototype-subject-empty">No matching subjects.</p>}</div>
              <Button variant="ghost" className="prototype-subject-add" onClick={() => { setSubjectPickerOpen(false); setNewSubject(true) }} disabled={recording}><Plus size={15} /> New subject</Button>
            </Popover.Content>
          </Popover.Root>
          <button className="prototype-sidebar-tool-button" aria-label="New subject" title="New subject" onClick={() => setNewSubject(true)} disabled={recording}><FolderPlus size={18} /></button>
          <button className="prototype-sidebar-tool-button" aria-label="New chat" title="New chat" onClick={() => createConversation(current?.subject ?? subject.name)} disabled={recording}><SquarePen size={18} /></button>
        </div>
        {current && <div className="prototype-mode-selector prototype-sidebar-mode-selector" role="group" aria-label="Conversation mode">{(['Study', 'Chat'] as Mode[]).map(mode => <button key={mode} aria-pressed={current.mode === mode} className={current.mode === mode ? 'active' : ''} disabled={recording} onClick={() => updateCurrent(value => ({ ...value, mode }))}>{mode}</button>)}</div>}
        <div className="prototype-sidebar-subjects">
          {conversations.filter(value => value.saved && (subjectFilter === 'all' || value.subject === subjectFilter) && `${value.title} ${subjectFilter === 'all' ? value.subject : ''}`.toLowerCase().includes(sidebarSearch.trim().toLowerCase())).map(value => <button key={value.id} className={`prototype-sidebar-conversation ${value.id === conversationId ? 'active' : ''}`} onClick={() => openConversation(value)} disabled={recording} aria-current={value.id === conversationId ? 'page' : undefined}>
            {subjectFilter === 'all' && <small>{value.subject}</small>}{value.title}
          </button>)}
          {!conversations.some(value => value.saved && (subjectFilter === 'all' || value.subject === subjectFilter) && `${value.title} ${subjectFilter === 'all' ? value.subject : ''}`.toLowerCase().includes(sidebarSearch.trim().toLowerCase())) && <p className="prototype-sidebar-empty">{sidebarSearch ? 'No matching conversations.' : 'No conversations yet.'}</p>}
        </div>
        <div className="prototype-sidebar-bottom"><Button variant="ghost" onClick={() => setSetup(true)} aria-label="Settings"><Settings2 size={17} /><span>Settings</span></Button></div>
      </aside>
      <main className="prototype-main">
        {allSubjectsOpen ? <div className="prototype-home">{allSubjects}</div> : !current ? <div className="prototype-home">{home}</div> : <div className="prototype-study">
          <header className="prototype-workspace-heading"><div className="prototype-workspace-breadcrumb"><button onClick={() => openSubject(subject.name)} disabled={recording}>{subject.name}</button><span aria-hidden="true">/</span><h1>{current.activeTopic ?? 'Select a topic'}</h1></div>{variant !== 'B' && materialButton}</header>
          <div className="prototype-workspace-controls">
            <Popover.Root modal={false} open={topicPicker} onOpenChange={open => { setTopicPicker(open); if (open) setTopicSelection(current.selectedTopics) }}>
              <Popover.Trigger asChild><Button variant="ghost" disabled={recording}>Topics <span>{current.selectedTopics.length}</span><ChevronDown size={14} /></Button></Popover.Trigger>
              <Popover.Content aria-label="Topics" className="prototype-topic-dropdown" align="start" sideOffset={6} collisionPadding={12}>
                <div className="prototype-topic-options">{subject.topics.map(topic => <label key={topic.name}><input type="checkbox" checked={topicSelection.includes(topic.name)} onChange={event => setTopicSelection(previous => event.target.checked ? [...previous, topic.name] : previous.filter(item => item !== topic.name))} />{topic.name}</label>)}{!subject.topics.length && <p>This subject has no topics yet. You can still use Chat.</p>}</div>
                {topicChangeBlocked && <p role="alert">Send or clear your draft before removing its focus topic.</p>}
                <Button onClick={applyTopics} disabled={topicChangeBlocked}>Apply topics</Button>
              </Popover.Content>
            </Popover.Root>
            {current.selectedTopics.length > 0 && <label className="prototype-question-topic">Focus<select aria-label="Focus topic" value={current.activeTopic ?? ''} disabled={recording || !!current.draft.trim()} onChange={event => updateCurrent(value => ({ ...value, activeTopic: event.target.value, finished: false }))}>{current.selectedTopics.map(topic => <option key={topic}>{topic}</option>)}</select></label>}
          </div>
          {!!current.draft.trim() && current.selectedTopics.length > 1 && <p className="prototype-inline-note">Send or clear your draft before changing the focus topic.</p>}
          <div className={`prototype-study-body ${variant === 'B' ? 'prototype-study-body-with-materials' : ''}`}><div className="prototype-study-main"><div className={`prototype-conversation ${current.turns.length === 0 ? 'prototype-conversation-empty' : ''}`}>
            {current.turns.map(turn => <article key={turn.id} className="prototype-turn" data-mode={turn.mode} data-topic={turn.topic ?? ''} data-assisted={turn.assisted}>
              {turn.question && <blockquote className="prototype-saved-question">{turn.question}</blockquote>}
              <section className="prototype-answer"><h3>{turn.question ? `Your answer · ${turn.topic}` : 'Your message'}</h3><p>{turn.answer}</p></section>
              <section className="prototype-feedback"><div className="prototype-feedback-heading"><AudioLines size={18} /><strong>{turn.question ? 'Study feedback' : `${turn.mode} response`}</strong></div>
                {turn.failed ? <><p>Your answer is retained. Feedback failed; no assessment was updated.</p><Button variant="outline" onClick={() => updateCurrent(value => ({ ...value, turns: value.turns.map(item => item.id === turn.id ? { ...item, failed: false } : item) }))}>Retry feedback</Button></> : <>
                  <p>{turn.reply}</p>
                  {turn.question && <div className="prototype-feedback-trust"><CircleHelp size={16} /><p>{turn.assisted ? 'Assisted attempt. Help was provided for this topic; this answer cannot establish independent understanding.' : 'Independent attempt.'} {turn.provisional ? 'Provisional: no verified applicable source support.' : 'Illustrative source support.'} No progress is updated in this demo.</p></div>}
                  {turn.guidanceTopics.length > 0 && <p className="prototype-inline-note">Help provided for {turn.guidanceTopics.join(', ')}. Your next Study answer on that topic will be assisted.</p>}
                </>}
              </section>
            </article>)}
            {current.finished && current.mode === 'Study' ? <section className="prototype-summary"><Check size={18} /><div><h2>Study paused</h2><p>Your messages and draft stay in this subject. No assessment was recorded in the demo.</p><Button variant="outline" onClick={() => updateCurrent(value => ({ ...value, finished: false }))}>Resume</Button></div></section> : null}
            {current.turns.length > 0 && !(current.finished && current.mode === 'Study') && current.activeTopic && <div className="prototype-feedback-actions"><Button variant="outline" onClick={explain} disabled={!ready || recording}>Explain {current.activeTopic.toLowerCase()}</Button>{current.mode === 'Study' && <Button variant="ghost" onClick={() => updateCurrent(value => ({ ...value, finished: true }))} disabled={recording || !!studyTurn?.failed}>Finish studying</Button>}</div>}
          </div>
          <div className="prototype-composer-dock">{!ready && warning}<div className="prototype-composer">
            <label className="sr-only" htmlFor="prototype-composer">Your message</label><Textarea id="prototype-composer" value={current.draft} onChange={event => updateCurrent(value => ({ ...value, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} placeholder="Message OutLoud…" />
            <div className="prototype-composer-toolbar"><span>Gemma 3:4b</span><Button variant={recording ? 'destructive' : 'ghost'} onClick={toggleRecording} disabled={!recording && (!ready || (current.finished && current.mode === 'Study'))} aria-label={recording ? 'Stop demo recording' : 'Start demo recording'}>{recording ? <Square size={17} /> : <Mic size={17} />}{recording ? 'Stop' : 'Dictate'}</Button><Button onClick={send} disabled={!ready || recording || !current.draft.trim() || (current.mode === 'Study' && (current.finished || !current.activeTopic))} aria-label="Send message"><ArrowRight size={17} /> Send</Button></div>
          </div><div className="prototype-composer-note"><span>{recording ? 'Simulated capture · Stop inserts example dictation' : 'Enter to send · Shift+Enter for a new line'}</span><button onClick={() => setDetails('evidence')}>Assessment evidence</button></div></div></div>
          {variant === 'B' ? materialsCard : variant === 'C' && <section className="prototype-source"><h3>Subject reference</h3><p>{subject.reference || 'No approved reference yet.'}</p>{materialButton}</section>}</div></div>}
      </main>
    </div>
    <div className="prototype-switcher"><button aria-label="Previous layout" onClick={() => cycle(-1)}><ArrowLeft size={16} /></button><span>{variant} · {variants[variant]}</span><button aria-label="Next layout" onClick={() => cycle(1)}><ArrowRight size={16} /></button><select aria-label="Demo scenario" value={readiness} onChange={event => { setReadiness(event.target.value as Readiness); setProgress(0); setRecording(false) }}><option value="ready">Normal</option><option value="missing">First launch</option><option value="downloading">Download in progress</option><option value="error">Download failed</option><option value="offline">Backend offline</option></select><label><input type="checkbox" checked={provisional} onChange={event => setProvisional(event.target.checked)} /> Provisional</label><label><input type="checkbox" checked={feedbackFailed} onChange={event => setFeedbackFailed(event.target.checked)} /> Feedback failed</label><details className="prototype-state"><summary>Inspect demo state</summary><pre>{JSON.stringify(state, null, 2)}</pre></details></div>
    {newSubject && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="new-subject-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close subject editor" onClick={() => setNewSubject(false)}><X /></Button><h2 id="new-subject-title">New subject</h2><form onSubmit={event => { event.preventDefault(); const name = newSubjectName.trim(); if (!name || subjects.some(item => item.name === name)) return; setSubjects(previous => [...previous, { name, reference: '', approved: false, topics: [...new Set(newTopics.split('\n').map(item => item.trim()).filter(Boolean))].map(topic => ({ name: topic, status: 'Not assessed', weight: null, evidence: 0 })) }]); openSubject(name); setNewSubject(false); setNewSubjectName(''); setNewTopics('') }}><label htmlFor="prototype-subject-name">Subject name</label><Input id="prototype-subject-name" value={newSubjectName} onChange={event => setNewSubjectName(event.target.value)} placeholder="e.g. Computer Networks" required /><label htmlFor="prototype-topic-names">Topics, one per line</label><Textarea id="prototype-topic-names" value={newTopics} onChange={event => setNewTopics(event.target.value)} placeholder={'Routing\nTCP'} />{subjects.some(item => item.name === newSubjectName.trim()) && <p role="alert">That subject already exists.</p>}<Button type="submit" disabled={!newSubjectName.trim() || subjects.some(item => item.name === newSubjectName.trim())}>Create subject</Button></form></section></div>}
    {setup && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="setup-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close setup" onClick={() => setSetup(false)}><X /></Button><h2 id="setup-title">Settings</h2><p>Model downloads need consent. This panel simulates setup and does not download anything.</p><div className="prototype-setup-step"><AudioLines size={18} /><div><strong>Whisper transcription</strong><small>Local dictation model</small></div></div><div className="prototype-setup-step"><BookOpen size={18} /><div><strong>Gemma 3:4b via Ollama</strong><small>Study and Chat · exact download size checked at setup</small></div></div>{readiness === 'downloading' && <><progress aria-label="Simulated model download" max={100} value={progress} /><p>{progress}% · simulated download{progress === 100 ? ' complete; verification required' : ''}</p></>}{readiness === 'error' && <p role="alert">Download interrupted. Saved subjects and conversations are unaffected.</p>}<div className="prototype-modal-actions">{readiness === 'downloading' ? <><Button variant="outline" onClick={() => setReadiness('missing')}>Cancel download</Button>{progress === 100 && <Button onClick={() => setReadiness('ready')}>Simulate successful verification</Button>}</> : <Button onClick={() => { setProgress(0); setReadiness('downloading') }}><ArrowDownToLine size={16} />{readiness === 'error' ? 'Retry demo download' : 'Consent & simulate download'}</Button>}<Button variant="ghost" onClick={() => setSetup(false)}>Set up later</Button></div></section></div>}
    {details && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="detail-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close details" onClick={() => setDetails(null)}><X /></Button><h2 id="detail-title">{details === 'materials' ? 'Syllabus and references' : 'Assessment evidence'}</h2>{details === 'materials' ? <><p>Shared by conversations in {subject.name}. Only reviewed, approved references can support assessments.</p><label htmlFor="prototype-reference">Reference text</label><Textarea id="prototype-reference" value={subject.reference} onChange={event => setSubjects(previous => previous.map(item => item.name === subject.name ? { ...item, reference: event.target.value, approved: false } : item))} /><p>{subject.approved ? 'Approved · demo source' : 'Pending review'}</p><Button onClick={() => setSubjects(previous => previous.map(item => item.name === subject.name ? { ...item, approved: true } : item))} disabled={!subject.reference.trim()}>Approve reviewed excerpt</Button></> : <><p>Assessed coverage and demonstrated understanding are separate. These demo attempts do not change saved progress.</p>{conversations.filter(item => item.subject === subject.name).flatMap(item => item.turns.filter(turn => turn.mode === 'Study' && turn.question).map(turn => <article key={turn.id} className="prototype-evidence-item"><strong>{item.title} · {turn.topic}</strong><p>{turn.assisted ? 'Assisted' : 'Independent'} · {turn.failed ? 'Feedback failed' : turn.provisional ? 'Provisional feedback' : 'Illustrative source support'}</p><blockquote>{turn.answer}</blockquote></article>))}</>}</section></div>}
  </div>
}
