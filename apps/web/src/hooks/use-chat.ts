import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { CONVERSATION_ID } from '@/hooks/use-dictation'

const HTTP_URL = 'http://127.0.0.1:8765'
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.started'), request_id: z.string() }),
  z.object({ type: z.literal('chat.delta'), request_id: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('chat.done'), request_id: z.string(), metrics: z.object({ elapsed_seconds: z.number().finite().nonnegative() }).catchall(z.number().finite().nonnegative()) }),
  z.object({ type: z.literal('chat.error'), request_id: z.string(), message: z.string() }),
  z.object({ type: z.literal('chat.cancelled'), request_id: z.string() }),
])

type Status = 'streaming' | 'complete' | 'cancelled' | 'failed'
export type ChatMessage = {
  id: string
  requestId: string
  role: 'user' | 'assistant'
  content: string
  status: Status
  metrics?: Record<string, number>
}
type Run = {
  id: string
  sessionId: string
  controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  stopped: boolean
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const history = useRef<ChatMessage[]>([])
  const run = useRef<Run | null>(null)
  const mounted = useRef(true)

  const update = useCallback((transform: (previous: ChatMessage[]) => ChatMessage[]) => {
    history.current = transform(history.current)
    if (mounted.current) setMessages(history.current)
  }, [])

  const stop = useCallback(async () => {
    const active = run.current
    if (!active || active.stopped) return
    active.stopped = true
    active.controller.abort()
    void active.reader?.cancel().catch(() => undefined)
    // Aborting the HTTP stream cancels upstream too. The explicit request covers
    // a transport that has not yet noticed the disconnect; stale IDs are harmless.
    try {
      await fetch(`${HTTP_URL}/chat/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-ID': active.sessionId },
        body: JSON.stringify({ request_id: active.id }), signal: AbortSignal.timeout(3000),
      })
    } catch { /* HTTP abort remains the fallback. */ }
  }, [])

  useEffect(() => {
    if (run.current && run.current.sessionId !== sessionId) void stop()
  }, [sessionId, stop])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; void stop() }
  }, [stop])

  const dismissError = useCallback(() => setError(null), [])

  const clear = useCallback(() => {
    if (run.current) return false
    history.current = []
    setMessages([])
    setError(null)
    return true
  }, [])

  const send = async (draft: string, onAccepted: () => void) => {
    const content = draft.trim()
    if (!sessionId || run.current || !content) return
    if (content.length > 12000) {
      setError('This message is too long. Shorten it to 12,000 characters or fewer.')
      return
    }
    const active: Run = { id: crypto.randomUUID(), sessionId, controller: new AbortController(), stopped: false }
    run.current = active
    setBusy(true)
    setError(null)
    let accepted = false
    let terminal = false
    const mark = (status: Status, metrics?: Record<string, number>) => update((previous) => previous.map((message) =>
      message.requestId === active.id ? { ...message, status, ...(message.role === 'assistant' && metrics ? { metrics } : {}) } : message))
    try {
      const context = history.current.filter((message) => message.status === 'complete').slice(-64)
        .map(({ role, content: text }) => ({ role, content: text }))
      const response = await fetch(`${HTTP_URL}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ request_id: active.id, conversation_id: CONVERSATION_ID, messages: [...context, { role: 'user', content }] }),
        signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(190000)]),
      })
      if (!response.ok) {
        if (response.status === 409) throw new Error('Gemma is already generating. Stop it or wait, then try again.')
        if (response.status === 403) throw new Error('The chat session expired. Reconnect before sending again.')
        if (response.status === 422) throw new Error('The message or conversation is too large. Shorten your text and try again.')
        throw new Error(`Chat request failed (${response.status}).`)
      }
      if (!response.body) throw new Error('The backend returned no chat stream.')
      const reader = response.body.getReader()
      active.reader = reader
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = ''
      const consume = (line: string) => {
        if (!line.trim()) return
        const event = eventSchema.parse(JSON.parse(line))
        if (event.request_id !== active.id) throw new Error('The backend returned a mismatched chat response.')
        if (terminal) throw new Error('The backend continued a completed chat response.')
        if (event.type === 'chat.started') {
          if (accepted) throw new Error('The backend restarted a chat response unexpectedly.')
          accepted = true
          update((previous) => [...previous,
            { id: `${active.id}-user`, requestId: active.id, role: 'user', content, status: 'streaming' },
            { id: `${active.id}-assistant`, requestId: active.id, role: 'assistant', content: '', status: 'streaming' },
          ])
          onAccepted()
        } else if (event.type === 'chat.delta') {
          if (!accepted) throw new Error('The backend sent text before accepting the message.')
          update((previous) => previous.map((message) => message.id === `${active.id}-assistant`
            ? { ...message, content: message.content + event.text } : message))
        } else if (event.type === 'chat.done') {
          if (!accepted) throw new Error('The backend completed a message it never accepted.')
          terminal = true
          mark('complete', event.metrics)
        } else if (event.type === 'chat.cancelled') {
          terminal = true
          active.stopped = true
          mark('cancelled')
        } else {
          throw new Error(event.message)
        }
      }
      while (!active.stopped && !terminal) {
        const { value, done } = await reader.read()
        if (active.stopped) break
        buffer += decoder.decode(value, { stream: !done })
        if (buffer.length > 262144) throw new Error('The backend returned an oversized chat event.')
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          consume(line)
        }
        if (done) {
          if (buffer.trim()) consume(buffer)
          break
        }
      }
      if (!terminal && !active.stopped) throw new Error('The response was interrupted. Any partial reply has been kept.')
      if (active.stopped) mark('cancelled')
    } catch (failure) {
      mark(active.stopped ? 'cancelled' : 'failed')
      if (!active.stopped && mounted.current) setError(failure instanceof Error ? failure.message : 'Chat failed. Try again.')
    } finally {
      await active.reader?.cancel().catch(() => undefined)
      if (run.current === active) {
        run.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }

  return { messages, busy, error, send, stop, clear, dismissError }
}
