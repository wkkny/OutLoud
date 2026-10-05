import { CircleDot, Cpu, MessageSquareText } from 'lucide-react'
import type { ConversationDetail } from '@/lib/conversations'

type Props = { conversation: ConversationDetail | undefined; connected: boolean }

export function ConversationDetailsCard({ conversation, connected }: Props) {
  return <aside className="conversation-details-card" aria-label="Conversation details">
    <div className="conversation-details-title"><MessageSquareText size={16} /><span>Conversation</span></div>
    <strong className="conversation-details-name">{conversation?.title ?? 'New conversation'}</strong>
    <div className="conversation-details-row"><CircleDot size={15} /><span>Local backend</span><i className={connected ? 'is-connected' : ''} aria-hidden="true" /></div>
    <div className="conversation-details-row"><Cpu size={15} /><span>Gemma 3:4b</span></div>
    {conversation && <div className="conversation-details-footer">{conversation.mode === 'study' ? 'Study mode' : 'Chat mode'} <span>·</span> {conversation.messages.length} {conversation.messages.length === 1 ? 'message' : 'messages'}</div>}
    {!conversation && <p className="conversation-details-description">Your chats stay on this device and are saved locally.</p>}
  </aside>
}
