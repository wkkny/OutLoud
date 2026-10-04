import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatViewMessage } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'

export function ChatMessage({ message, onRetry, retryDisabled }: { message: ChatViewMessage; onRetry?: () => void; retryDisabled?: boolean }) {
  return <article className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} aria-label={message.role === 'user' ? 'You' : 'Gemma'}>
    <div className="message-body">
      {message.role === 'user' ? <p className="user-bubble">{message.content}</p> : <div className="typeset typeset-chat">
        <Markdown remarkPlugins={[remarkGfm]} components={{
          // Model output must not load remote images automatically.
          img: ({ alt }) => <span>[Image: {alt || 'image'}]</span>,
          table: ({ children }) => <div className="typeset-scroll"><table>{children}</table></div>,
        }}>{message.content || (message.status === 'streaming' ? 'Thinking…' : 'No reply received.')}</Markdown>
      </div>}
      {message.delivery === 'sending' && <p role="status" className="message-meta">Sending…</p>}
      {message.delivery === 'failed' && <div className="message-meta flex items-center gap-2"><span>Not sent</span><Button variant="outline" size="xs" disabled={retryDisabled} onClick={onRetry}>Retry</Button></div>}
      {!message.delivery && message.status !== 'complete' && <p className="message-meta">{message.status === 'streaming' ? 'Generating…' : `${message.status} · partial reply`}</p>}
      {message.metrics && <p className="message-meta">{message.metrics.elapsed_seconds?.toFixed(1)}s{message.metrics.output_tokens !== undefined && ` · ${message.metrics.output_tokens} output tokens`}</p>}
    </div>
  </article>
}
