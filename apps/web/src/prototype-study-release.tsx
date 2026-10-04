// THROWAWAY: three Study layouts on the existing app route, ?prototype=study-release&variant=A|B|C.
// All data, feedback, recording, and download actions are simulated in memory. No backend calls.
import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, CircleHelp, FileText, MessageSquare, Mic, Plus, Settings2, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import './prototype-study-release.css'

type Variant = 'A' | 'B' | 'C'
type Screen = 'home' | 'study' | 'chat'
type Readiness = 'ready' | 'missing' | 'downloading' | 'error' | 'offline'
type Topic = { name: string; status: 'Needs revision' | 'Partial understanding' | 'Not assessed' | 'Demonstrated understanding'; weight: number | null; evidence: number }
const variants: Record<Variant, string> = { A: 'Study dashboard', B: 'Revision queue', C: 'Subject notebook' }
const startingTopics: Topic[] = [
  { name: 'Normalization', status: 'Needs revision', weight: 20, evidence: 2 },
  { name: 'Transactions', status: 'Partial understanding', weight: 25, evidence: 1 },
  { name: 'Indexing', status: 'Not assessed', weight: null, evidence: 0 },
  { name: 'Relational algebra', status: 'Demonstrated understanding', weight: 15, evidence: 3 },
]
const statusClass = (status: Topic['status']) => status === 'Needs revision' ? 'needs' : status === 'Demonstrated understanding' ? 'demonstrated' : 'neutral'
const question = 'Explain how third normal form prevents a transitive dependency. Can you give an example of a table you would split?'
const sourceText = 'A relation is in 3NF when, for each non-trivial functional dependency X → A, X is a superkey or A is a prime attribute. Removing transitive dependencies can prevent update anomalies.'

export default function StudyReleasePrototype() {
  const params = new URLSearchParams(location.search)
  const initialVariant = params.get('variant') as Variant
  const [variant, setVariant] = useState<Variant>(initialVariant in variants ? initialVariant : 'A')
  const [screen, setScreen] = useState<Screen>('home')
  const [readiness, setReadiness] = useState<Readiness>('ready')
  const [progress, setProgress] = useState(0)
  const [setup, setSetup] = useState(false)
  const [subjects, setSubjects] = useState(['Database Management Systems', 'Operating Systems'])
  const [subject, setSubject] = useState('Database Management Systems')
  const [subjectTopics, setSubjectTopics] = useState<Record<string, Topic[]>>({
    'Database Management Systems': startingTopics,
    'Operating Systems': [
      { name: 'Process scheduling', status: 'Not assessed', weight: null, evidence: 0 },
      { name: 'Deadlocks', status: 'Partial understanding', weight: 15, evidence: 1 },
    ],
  })
  const topics = subjectTopics[subject] ?? []
  const nextTopic = topics[0]
  const [topic, setTopic] = useState('Normalization')
  const [newSubject, setNewSubject] = useState(false)
  const [subjectName, setSubjectName] = useState('')
  const [topicNames, setTopicNames] = useState('')
  const [draft, setDraft] = useState('')
  const [recording, setRecording] = useState(false)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState(false)
  const [guided, setGuided] = useState(false)
  const [finished, setFinished] = useState(false)
  const [provisional, setProvisional] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)
  const [showMaterials, setShowMaterials] = useState(false)
  const [reviewed, setReviewed] = useState(true)
  const [reference, setReference] = useState(sourceText)
  const [feedbackFailed, setFeedbackFailed] = useState(false)
  const ready = readiness === 'ready'
  const modelMessage = readiness === 'offline' ? 'The local backend is unavailable. Your draft stays here.' : readiness === 'downloading' ? `Setting up models · ${progress}%` : readiness === 'error' ? 'Model download interrupted. You can retry setup.' : 'Models are not installed yet. You can still organize your subjects.'
  const activeTopic = topics.find(item => item.name === topic)
  const state = { variant, screen, subject, topic, readiness, progress, draft, recording, guided, provisional, reviewed, feedbackFailed, finished, answer, subjects, topics }
  const changeVariant = (next: Variant) => {
    setVariant(next)
    const url = new URL(location.href)
    url.searchParams.set('variant', next)
    history.replaceState(null, '', url)
  }
  const cycle = (delta: number) => {
    const keys: Variant[] = ['A', 'B', 'C']
    changeVariant(keys[(keys.indexOf(variant) + delta + keys.length) % keys.length])
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(event.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (readiness !== 'downloading') return
    const timer = setInterval(() => setProgress(previous => Math.min(previous + 5, 100)), 250)
    return () => clearInterval(timer)
  }, [readiness])
  const startTopic = (name: string) => {
    setTopic(name); setScreen('study'); setAnswer(''); setFeedback(false); setGuided(false); setFinished(false); setFeedbackFailed(false)
  }
  const send = () => {
    if (!ready || !draft.trim()) return
    setAnswer(draft); setDraft(''); setFeedback(true); setFinished(false)
  }
  const toggleRecording = () => {
    if (recording) { setRecording(false); setDraft(previous => [previous, 'I would separate the department details because the department name depends on the department ID, rather than directly on the employee ID.'].filter(Boolean).join('\n')) }
    else if (ready) setRecording(true)
  }
  const openHome = () => { setScreen('home'); setRecording(false) }
  const status = (item: Topic) => <span className={`prototype-status ${statusClass(item.status)}`}>{item.status}</span>
  const assessed = topics.filter(item => item.evidence > 0).length
  const demonstrated = topics.filter(item => item.status === 'Demonstrated understanding').length
  const stats = <div className="prototype-stats"><div><strong>{assessed} / {topics.length}</strong><span>Topics assessed</span></div><div><strong>{demonstrated} / {topics.length}</strong><span>Understanding demonstrated</span></div><div><strong>Unknown</strong><span>Exam date · add when ready</span></div></div>
  const resume = <section className="prototype-resume"><div className="prototype-eyebrow">{nextTopic?.evidence ? 'PICK UP WHERE YOU LEFT OFF' : 'YOUR NEXT STEP'}</div><h2>{nextTopic?.name ?? 'Add topics to get started'}</h2><p>{nextTopic?.evidence ? 'Continue with the last saved question and reviewed answer. Progress is supported by your evidence, not time spent.' : 'Start with your own explanation. Topics you have not studied remain not assessed.'}</p><Button onClick={() => { if (nextTopic) startTopic(nextTopic.name) }} disabled={!ready || !nextTopic}>{nextTopic?.evidence ? 'Resume studying' : 'Study a topic'} <ArrowRight size={16} /></Button></section>
  const topicRows = <div className="prototype-topic-list">{topics.map((item, index) => <button key={item.name} onClick={() => startTopic(item.name)} disabled={!ready} className="prototype-topic-row"><span className="prototype-priority">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.name}</strong><small>{item.weight === null ? 'Exam importance unknown' : `${item.weight}% exam importance`} · {item.evidence ? `${item.evidence} evidence records` : 'No assessment evidence yet'}</small></div>{status(item)}<ChevronRight size={16} /></button>)}</div>
  const homeHeading = <header className="prototype-section-heading"><div><span className="prototype-eyebrow">YOUR STUDY SPACE</span><h1>Make the next session count.</h1><p>Resume a topic, or choose what to revise next.</p></div><Button variant="outline" onClick={() => setNewSubject(true)}><Plus size={16} /> New subject</Button></header>
  const subjectTabs = <nav className="prototype-subject-tabs" aria-label="Subjects">{subjects.map(name => <Button key={name} variant={subject === name ? 'secondary' : 'ghost'} onClick={() => setSubject(name)}>{name}</Button>)}</nav>
  const home = variant === 'A' ? <>
    {homeHeading}{subjectTabs}{stats}
    <div className="prototype-dashboard-grid">{resume}<section className="prototype-material-card"><FileText size={22} /><h3>Your syllabus, your scope.</h3><p>{topics.length} topics · approved reference fixture. Review the sources used to assess your answers.</p><Button variant="outline" onClick={() => setShowMaterials(true)}>Manage materials</Button></section></div>
    <section><div className="prototype-list-heading"><h2>What to revise next</h2><span>Gaps and exam importance, not a grade</span></div>{topicRows}</section>
  </> : variant === 'B' ? <>
    <header className="prototype-queue-heading"><span className="prototype-eyebrow">A LITTLE PROGRESS, EVERY DAY</span><h1>One topic at a time.</h1><p>Start with the most useful thing to work on next.</p></header>{subjectTabs}
    <div className="prototype-queue-summary"><span><strong>{assessed}</strong> topics assessed</span><span><strong>{demonstrated}</strong> demonstrated</span><Button variant="ghost" onClick={() => setNewSubject(true)}><Plus size={16} /> Subject</Button><Button variant="ghost" onClick={() => setShowMaterials(true)}><FileText size={16} /> Materials</Button></div>
    <section className="prototype-next-topic"><Badge variant="secondary">Recommended next</Badge><h2>{nextTopic?.name ?? 'Create your syllabus'}</h2><p>Take a fresh independent question. Exam importance: {nextTopic?.weight == null ? 'Unknown' : `${nextTopic.weight}% supplied weighting`}.</p><Button onClick={() => { if (nextTopic) startTopic(nextTopic.name) }} disabled={!ready || !nextTopic}>Continue this topic <ArrowRight size={16} /></Button></section>
    <h2 className="prototype-small-heading">Your revision queue</h2>{topicRows}
  </> : <div className="prototype-notebook">
    <aside className="prototype-notebook-index"><span className="prototype-eyebrow">SUBJECT NOTEBOOKS</span>{subjects.map(name => <button key={name} className={subject === name ? 'active' : ''} onClick={() => setSubject(name)}><BookOpen size={17} />{name}</button>)}<Button variant="ghost" onClick={() => setNewSubject(true)}><Plus size={16} /> Add subject</Button><hr /><span className="prototype-eyebrow">SYLLABUS</span>{topics.map(item => <button key={item.name} onClick={() => startTopic(item.name)} disabled={!ready}>{item.name}<span className={`prototype-dot ${statusClass(item.status)}`} /></button>)}<Button variant="ghost" onClick={() => setShowMaterials(true)}><FileText size={16} /> Reference material</Button></aside>
    <section className="prototype-notebook-page"><span className="prototype-eyebrow">YOUR SUBJECT AT A GLANCE</span><h1>{subject}</h1><p>Learning is more than covering the syllabus. See what your answers actually demonstrate.</p>{stats}{resume}<h2 className="prototype-small-heading">Recent study evidence</h2><div className="prototype-timeline">{topics.filter(item => item.evidence > 0).map(item => <article key={item.name}><span>Illustrative saved evidence</span><strong>{item.name} · {item.status.toLowerCase()}</strong><p>{item.evidence} supporting records. Review the answers and source support before relying on this assessment.</p><button onClick={() => setShowEvidence(true)}>Read supporting evidence <ArrowRight size={14} /></button></article>)}{!assessed && <p>No assessment evidence yet. Studying a topic will start with your own explanation.</p>}</div></section>
  </div>
  const studyHeader = <div className="prototype-study-heading"><Button variant="ghost" onClick={openHome}><ArrowLeft size={16} /> Study home</Button><div><span>{subject}</span><h1>{topic}</h1></div><div className="prototype-study-status">{activeTopic && status(activeTopic)}<small>Exam importance: {activeTopic?.weight == null ? 'Unknown' : `${activeTopic.weight}%`}</small></div></div>
  const sourcePanel = <section className="prototype-source"><FileText size={18} /><h3>Reference for this topic</h3><p>{reference}</p><small>Approved textbook excerpt · illustrative fixture</small><Button variant="ghost" onClick={() => setShowMaterials(true)}>Review material</Button></section>
  const conversation = <div className="prototype-conversation">
    <section className="prototype-question"><span className="prototype-eyebrow">{guided ? 'FRESH PRACTICE AFTER GUIDANCE' : 'CURRENT QUESTION'}</span><h2>{screen === 'chat' ? 'What would you like to talk about?' : guided ? 'Give a new example of an update anomaly. Explain which dependency causes it and how you would remove it.' : topic === 'Normalization' ? question : `Explain ${topic.toLowerCase()} in your own words, with an example.`}</h2><p>Speak or type. Review your answer before sending.</p></section>
    {answer && <section className="prototype-answer"><span className="prototype-eyebrow">YOUR REVIEWED ANSWER · {guided ? 'AFTER GUIDANCE' : 'INDEPENDENT ATTEMPT'}</span><p>{answer}</p></section>}
    {feedback && <section className="prototype-feedback"><div className="prototype-feedback-heading"><AudioLines size={18} /><strong>{screen === 'chat' ? 'Demo response' : 'Feedback on this attempt'}</strong><Badge variant="outline">Simulated</Badge></div>{feedbackFailed ? <><p>Your answer is retained. Feedback was interrupted; no topic assessment has been updated.</p><Button variant="outline" onClick={() => setFeedbackFailed(false)}>Retry feedback</Button></> : <><p>{screen === 'chat' ? 'This is a prototype conversation. No message was sent to a model.' : 'The sample answer separates employee and department details. A follow-up should check that the learner understands which functional dependency causes the anomaly.'}</p><div className="prototype-feedback-trust"><CircleHelp size={16} /><p>{provisional || !reviewed ? 'Provisional guidance · no approved source support. This does not establish a knowledge gap or update progress.' : guided ? 'Answer after guidance · practice is useful, but this answer alone cannot establish independent understanding.' : 'Illustrative reference-supported feedback. Progress stays unchanged in this prototype; real assessment requires sufficient independent evidence.'}</p></div>{screen === 'study' && <><p className="prototype-followup"><strong>Next question</strong>What changes if the department name is duplicated in every employee row?</p><div className="prototype-feedback-actions"><Button variant="outline" onClick={() => setGuided(true)}>Explain this</Button><Button variant="outline" onClick={() => { setGuided(true); setFeedback(false) }}>Practice this</Button><Button variant="ghost" onClick={openHome}>Move on</Button><Button variant="ghost" onClick={() => setFinished(true)}>Finish studying</Button></div></>}</> }</section>}
    {finished && <section className="prototype-summary"><Check size={18} /><div><h3>Session summary</h3><p>One reviewed answer · {guided ? 'guidance used' : 'independent attempt'}. No new assessment was recorded in this demo.</p><Button variant="outline" onClick={openHome}>Back to study home</Button></div></section>}
  </div>
  const composer = <div className="prototype-composer-dock">{!ready && <p className="prototype-inline-warning">{modelMessage}</p>}<div className="prototype-composer"><label className="sr-only" htmlFor="prototype-composer">Your answer</label><Textarea id="prototype-composer" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} placeholder={screen === 'study' ? 'Explain it in your own words…' : 'Message OutLoud…'} /><div className="prototype-composer-toolbar"><span>Gemma 3:4b <small>· simulated</small></span><Button variant={recording ? 'destructive' : 'ghost'} onClick={toggleRecording} disabled={!recording && !ready} aria-label={recording ? 'Stop demo recording' : 'Start demo recording'}>{recording ? <Square size={17} /> : <Mic size={17} />}{recording ? 'Stop' : 'Dictate'}</Button><Button onClick={send} disabled={!ready || !draft.trim()} aria-label="Send answer"><ArrowRight size={17} /> Send</Button></div></div><div className="prototype-composer-note"><span>{recording ? 'Simulated capture · stopping inserts example dictation' : 'Enter to send · Shift+Enter for a new line'}</span><button onClick={() => setShowEvidence(true)}>View assessment evidence</button></div></div>

  return <div className={`study-release-prototype variant-${variant}`}>
    <div className="prototype-banner">PROTOTYPE · all data and actions are simulated · changes disappear on reload</div>
    <div className="prototype-shell">
      <aside className="prototype-sidebar"><div className="prototype-brand"><AudioLines size={23} /><strong>OutLoud</strong><Badge variant="outline">Local</Badge></div><nav aria-label="App navigation"><button className={screen !== 'chat' ? 'active' : ''} onClick={openHome}><BookOpen size={18} /><span>Study</span></button><button className={screen === 'chat' ? 'active' : ''} onClick={() => { setScreen('chat'); setAnswer(''); setFeedback(false); setRecording(false) }}><MessageSquare size={18} /><span>Chat</span></button></nav><div className="prototype-sidebar-subjects"><span className="prototype-eyebrow">YOUR SUBJECTS</span>{subjects.map(name => <button key={name} onClick={() => { setSubject(name); openHome() }}>{name}</button>)}</div><div className="prototype-sidebar-bottom"><Button variant="ghost" onClick={() => setSetup(true)}><Settings2 size={17} />Setup & settings</Button><span><span className={`prototype-dot ${ready ? 'demonstrated' : 'needs'}`} />{ready ? 'Models ready · demo' : 'Setup needs attention'}</span></div></aside>
      <main className="prototype-main"><header className="prototype-topbar"><span>{screen === 'home' ? 'Study home' : screen === 'study' ? 'Study workspace' : 'Ordinary chat'}</span><Button variant="ghost" onClick={() => setSetup(true)}>{ready ? <Check size={15} /> : <ArrowDownToLine size={15} />}{ready ? 'Ready to study' : 'Complete setup'}</Button></header>
        {!ready && <div className="prototype-readiness" role="status"><div><strong>{readiness === 'offline' ? 'Disconnected' : 'Setup isn’t finished'}</strong><p>{modelMessage} Manual subject setup remains available.</p></div><Button variant="outline" onClick={() => setSetup(true)}>Complete setup</Button></div>}
        {screen === 'home' ? <div className="prototype-home">{home}</div> : <div className="prototype-study">{screen === 'study' && studyHeader}<div className="prototype-study-body">{conversation}{variant === 'C' && screen === 'study' ? sourcePanel : null}</div>{screen === 'study' && variant === 'B' && <div className="prototype-session-strip"><span>1 · Explain</span><strong>2 · Review feedback</strong><span>3 · Practice independently</span></div>}{composer}</div>}
      </main>
    </div>
    <details className="prototype-state"><summary>Inspect demo state</summary><pre>{JSON.stringify(state, null, 2)}</pre></details>
    <div className="prototype-switcher"><button aria-label="Previous layout" onClick={() => cycle(-1)}><ArrowLeft size={16} /></button><span><small>COMPARE LAYOUTS</small>{variant} · {variants[variant]}</span><button aria-label="Next layout" onClick={() => cycle(1)}><ArrowRight size={16} /></button><select aria-label="Demo scenario" value={readiness} onChange={event => { setReadiness(event.target.value as Readiness); setProgress(0); setRecording(false) }}><option value="ready">Models ready</option><option value="missing">First launch</option><option value="downloading">Download in progress</option><option value="error">Download failed</option><option value="offline">Backend offline</option></select><label><input type="checkbox" checked={provisional} onChange={event => setProvisional(event.target.checked)} /> Provisional</label><label><input type="checkbox" checked={feedbackFailed} onChange={event => setFeedbackFailed(event.target.checked)} /> Feedback failed</label></div>
    {newSubject && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="new-subject-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close subject editor" onClick={() => setNewSubject(false)}><X /></Button><span className="prototype-eyebrow">START SMALL</span><h2 id="new-subject-title">What are you studying?</h2><p>A subject and a few topics are enough. Exam details and reference material can come later.</p><form onSubmit={event => { event.preventDefault(); const name = subjectName.trim(); if (!name) return; setSubjects(previous => [...previous, name]); setSubject(name); setSubjectTopics(previous => ({ ...previous, [name]: topicNames.split('\n').map(name => name.trim()).filter(Boolean).map(name => ({ name, status: 'Not assessed', weight: null, evidence: 0 })) })); setNewSubject(false); setSubjectName(''); setTopicNames('') }}><label htmlFor="prototype-subject-name">Subject name</label><Input id="prototype-subject-name" value={subjectName} onChange={event => setSubjectName(event.target.value)} placeholder="e.g. Database Management Systems" required /><label htmlFor="prototype-topic-names">Topics, one per line</label><Textarea id="prototype-topic-names" value={topicNames} onChange={event => setTopicNames(event.target.value)} placeholder={'Normalization\nTransactions\nIndexing'} /><small>No model download is needed for this step.</small><Button type="submit" disabled={!subjectName.trim()}>Create subject</Button></form></section></div>}
    {setup && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="setup-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close setup" onClick={() => setSetup(false)}><X /></Button><span className="prototype-eyebrow">LOCAL MODELS · YOUR CHOICE</span><h2 id="setup-title">Get ready to study.</h2><p>The installer won’t include large models. Review the download before starting. This panel simulates setup; it does not download anything.</p><div className="prototype-setup-step"><Check size={18} /><div><strong>App and local backend</strong><small>{readiness === 'offline' ? 'Backend disconnected · reconnect needed' : 'Included with the app · simulated'}</small></div></div><div className="prototype-setup-step"><AudioLines size={18} /><div><strong>Whisper transcription</strong><small>Local dictation model · downloaded with consent</small></div></div><div className="prototype-setup-step"><BookOpen size={18} /><div><strong>Gemma 3:4b via Ollama</strong><small>Local study feedback · large download. Exact size checked at setup.</small></div></div>{readiness === 'downloading' && <><progress aria-label="Simulated model download" max={100} value={progress} /><p>{progress}% · simulated download{progress === 100 ? ' complete; ready for verification' : ''}</p></>}{readiness === 'error' && <p role="alert">Download interrupted. Saved subjects and progress are unaffected.</p>}<div className="prototype-modal-actions">{readiness === 'downloading' ? <><Button variant="outline" onClick={() => setReadiness('missing')}>Cancel download</Button>{progress === 100 && <Button onClick={() => setReadiness('ready')}>Simulate successful verification</Button>}</> : <Button onClick={() => { setProgress(0); setReadiness('downloading') }}><ArrowDownToLine size={16} />{readiness === 'error' ? 'Retry demo download' : 'Consent & simulate download'}</Button>}<Button variant="ghost" onClick={() => setSetup(false)}>Set up later</Button></div></section></div>}
    {(showEvidence || showMaterials) && <div className="prototype-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="detail-title" className="prototype-modal"><Button variant="ghost" className="prototype-modal-close" aria-label="Close details" onClick={() => { setShowEvidence(false); setShowMaterials(false) }}><X /></Button><span className="prototype-eyebrow">{showMaterials ? 'MATERIAL REVIEW' : 'WHY THIS ASSESSMENT?'}</span><h2 id="detail-title">{showMaterials ? 'Syllabus and references' : 'Assessment evidence'}</h2>{showMaterials ? <><p>A syllabus defines topics. References support feedback. Neither is used until you approve the reviewed content.</p><label htmlFor="prototype-reference">Reviewed reference text</label><Textarea id="prototype-reference" value={reference} onChange={event => { setReference(event.target.value); setReviewed(false) }} /><p>{reviewed ? 'Approved · simulated source' : 'Pending review · feedback will be provisional'}</p><Button onClick={() => setReviewed(true)} disabled={!reference.trim()}>Approve reviewed excerpt</Button></> : <><p><strong>Normalization · needs revision</strong></p><p>Sample evidence from two independent attempts. This is an illustrative fixture, not a live judgment.</p><blockquote>“I would keep a department’s name in the employee table and change each row when it changes.”</blockquote><p>The cited reference describes dependencies and update anomalies. The learner’s answer needs a fresh supported reassessment.</p><p className="prototype-muted">Assessed coverage is separate from demonstrated understanding. An untested topic is not an established gap.</p></>}</section></div>}
  </div>
}
