import type { ConversationDetail, ConversationLibrary } from '@/lib/conversations'
import type { StudySubject } from '@/lib/study'

type Props = { conversation: ConversationDetail | undefined; subject: StudySubject | null; library: ConversationLibrary; disabled: boolean }

export function ConversationTopicControls({ conversation, subject, library, disabled }: Props) {
  if (!conversation || !subject) return null
  const topicIds = conversation.topic_ids
  const activeTopics = subject.topics.filter(topic => topic.active)
  const update = (next: string[]) => {
    const focus = conversation.focus_topic_id && next.includes(conversation.focus_topic_id) ? conversation.focus_topic_id : next[0] ?? null
    void library.updateWorkspace(conversation.id, { topic_ids: next, focus_topic_id: focus })
  }
  return <div className="workspace-topic-controls">
    <details>
      <summary>Topics <span>{topicIds.length}</span></summary>
      <div className="workspace-topic-options" aria-label="Select topics">
        {activeTopics.map(topic => <label key={topic.id}><input type="checkbox" checked={topicIds.includes(topic.id)} disabled={disabled} onChange={event => update(event.target.checked ? [...topicIds, topic.id] : topicIds.filter(id => id !== topic.id))} />{topic.name}</label>)}
        {!activeTopics.length && <p>This subject has no active topics yet.</p>}
      </div>
    </details>
    {topicIds.length > 0 && <label className="workspace-focus">Focus
      <select aria-label="Focus topic" value={conversation.focus_topic_id ?? topicIds[0] ?? ''} disabled={disabled} onChange={event => { void library.updateWorkspace(conversation.id, { topic_ids: topicIds, focus_topic_id: event.target.value }) }}>
        {topicIds.map(id => { const topic = activeTopics.find(item => item.id === id); return topic ? <option key={id} value={id}>{topic.name}</option> : null })}
      </select>
    </label>}
  </div>
}
