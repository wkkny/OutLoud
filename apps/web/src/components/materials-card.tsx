import { useState } from 'react'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { request } from '@/lib/conversations'
import { listSubjects, studyJson, type StudySubject } from '@/lib/study'

type Props = { subject: StudySubject | null; onOpenStudy: () => void; onSubjectsChanged: (subjects: StudySubject[]) => void }

export function MaterialsCard({ subject, onOpenStudy, onSubjectsChanged }: Props) {
  const source = subject?.uploads.find(upload => upload.role === 'reference')
  const [text, setText] = useState(source?.text ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = text.trim() !== (source?.text ?? '')
  const save = async () => {
    if (!subject || !text.trim() || saving) return
    setSaving(true); setError(null)
    try {
      if (source) {
        await request(`/study/uploads/${encodeURIComponent(source.id)}`, studyJson('PATCH', { text: text.trim(), topic_ids: source.topic_ids, topics: [] }))
      } else {
        await request(`/study/subjects/${encodeURIComponent(subject.id)}/references`, studyJson('POST', { name: 'Quick reference', text: text.trim(), topic_ids: [] }))
      }
      onSubjectsChanged(await listSubjects())
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The reference could not be saved.') }
    finally { setSaving(false) }
  }
  return <aside className="materials-card" aria-label="Materials">
    <div className="materials-card-heading"><FileText size={17} /><h2>Materials</h2></div>
    {subject ? <>
      <p className="materials-subject">{subject.name}</p>
      <p className="materials-description">Reviewed references stay close while you study or chat.</p>
      <label htmlFor="quick-reference">Reference text</label>
      <Textarea id="quick-reference" value={text} onChange={event => setText(event.target.value)} placeholder="Add a useful excerpt…" />
      <small className="materials-status" role="status">{error ?? (source?.approved && !changed ? 'Approved reference' : changed ? 'Changes need approval' : source ? 'Pending review' : 'No reference added')}</small>
      <Button size="sm" onClick={() => void save()} disabled={saving || !text.trim() || (!changed && Boolean(source?.approved))}>{saving ? 'Saving…' : source?.approved && !changed ? 'Approved' : 'Approve reference'}</Button>
    </> : <p className="materials-description">Choose or create a subject to keep its approved syllabus and references here.</p>}
    <Button variant="ghost" size="sm" className="materials-manage" onClick={onOpenStudy}>Manage syllabus and uploads</Button>
  </aside>
}
