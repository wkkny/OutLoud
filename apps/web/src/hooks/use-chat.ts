import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { HTTP_URL } from '@/lib/backend-url'
import type { ConversationDetail, ConversationLibrary, SavedMessage } from '@/lib/conversations'
import { readPendingSends, writePendingSends, type PendingSend } from '@/lib/chat-recovery'

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.started'), request_id: z.string() }),
  z.object({ type: z.literal('chat.delta'), request_id: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('chat.done'), request_id: z.string(), metrics: z.object({ elapsed_seconds: z.number().finite().nonnegative() }).catchall(z.number().finite().nonnegative()) }),
  z.object({ type: z.literal('chat.error'), request_id: z.string(), message: z.string() }),
  z.object({ type: z.literal('chat.cancelled'), request_id: z.string() }),
])

type Status = SavedMessage['status']
export type ChatViewMessage = SavedMessage & { delivery?: PendingSend['delivery']; pendingSend?: PendingSend }
type Run = { id: string; conversationId: string; sessionId: string; controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; stopped: boolean }

/** Live runs are keyed by conversation, not selection. Reloads cannot replace a live stream. */
export function useChat(sessionId: string | null, selectedId: string | null, details: Record<string, ConversationDetail>, historyRevisions: Record<string, number>, library: ConversationLibrary) {
  const [live, setLive] = useState<Record<string, SavedMessage[]>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(readPendingSends)
  const pendingRef = useRef(pending)
  const history = useRef<Record<string, SavedMessage[]>>({})
  const runs = useRef(new Map<string, Run>())
  const mounted = useRef(true)
  const latestDetails = useRef(details)
  const observedHistory = useRef(historyRevisions)
  useEffect(() => { latestDetails.current = details }, [details])

  const changePending = useCallback((transform: (previous: PendingSend[]) => PendingSend[]) => {
    pendingRef.current = transform(pendingRef.current)
    if (mounted.current) {
      writePendingSends(pendingRef.current)
      setPending(pendingRef.current)
    }
  }, [])
  const prepare = (conversationId: string | null, text: string, retry?: PendingSend) => {
    const previousAttempt = retry ?? pendingRef.current.findLast((item) => item.conversationId === conversationId && item.text === text && item.delivery === 'failed')
    const item: PendingSend = previousAttempt ? { ...previousAttempt, delivery: 'sending' } : {
      id: crypto.randomUUID(), conversationId, text, createdAt: new Date().toISOString(), delivery: 'sending',
    }
    changePending((previous) => [...previous.filter((entry) => entry.id !== item.id), item])
    return item
  }
  const attach = (requestId: string, conversationId: string) => changePending((previous) => previous.map((item) => item.id === requestId ? { ...item, conversationId } : item))
  const fail = (requestId: string) => changePending((previous) => previous.map((item) => item.id === requestId ? { ...item, delivery: 'failed' } : item))
  const removePending = (requestId: string) => changePending((previous) => previous.filter((item) => item.id !== requestId))
  useEffect(() => {
    const confirmed = pendingRef.current.filter((item) => item.conversationId && details[item.conversationId]?.messages.some((message) => message.role === 'user' && message.request_id === item.id))
    if (!confirmed.length) return
    changePending((previous) => previous.filter((item) => !confirmed.some((entry) => entry.id === item.id)))
    for (const item of confirmed) void library.clearAccepted(item.conversationId!, item.text)
  }, [details, library, changePending])

  const update = useCallback((id: string, transform: (previous: SavedMessage[]) => SavedMessage[]) => {
    history.current = { ...history.current, [id]: transform(history.current[id] ?? latestDetails.current[id]?.messages ?? []) }
    if (mounted.current) setLive(history.current)
  }, [])
  const stopRun = useCallback(async (active: Run) => {
    if (active.stopped) return
    active.stopped = true; active.controller.abort()
    void active.reader?.cancel().catch(() => undefined)
    try {
      await fetch(`${HTTP_URL}/chat/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-ID': active.sessionId },
        body: JSON.stringify({ request_id: active.id }), signal: AbortSignal.timeout(3000),
      })
    } catch { /* Stream abort also cancels upstream. */ }
  }, [])
  useEffect(() => {
    for (const active of runs.current.values()) if (active.sessionId !== sessionId) void stopRun(active)
  }, [sessionId, stopRun])
  useEffect(() => {
    mounted.current = true
    const activeRuns = runs.current
    return () => { mounted.current = false; for (const active of activeRuns.values()) void stopRun(active) }
  }, [stopRun])
  useEffect(() => {
    // Only a fresh GET of this conversation can retire its orphaned overlay.
    // Unrelated loads and delayed draft-save responses cannot recover history.
    let changed = false
    const next: Record<string, SavedMessage[]> = {}
    for (const [id, messages] of Object.entries(history.current)) {
      if ((historyRevisions[id] ?? 0) > (observedHistory.current[id] ?? 0) && !runs.current.has(id)) changed = true
      else next[id] = messages
    }
    observedHistory.current = historyRevisions
    if (changed) { history.current = next; if (mounted.current) setLive(next) }
  }, [historyRevisions])

  const send = async (id: string, draft: string, onAccepted: () => void, requestId: string) => {
    const content = draft.trim()
    if (!sessionId || runs.current.has(id) || !content) { fail(requestId); return }
    const setError = (message: string) => { if (mounted.current) setErrors((previous) => ({ ...previous, [id]: message })) }
    if (content.length > 12000) { fail(requestId); setError('This message is too long. Shorten it to 12,000 characters or fewer.'); return }
    const active: Run = { id: requestId, conversationId: id, sessionId, controller: new AbortController(), stopped: false }
    runs.current.set(id, active)
    setBusyIds(new Set(runs.current.keys()))
    setErrors((previous) => { const next = { ...previous }; delete next[id]; return next })
    let accepted = false
    let terminal = false
    const mark = (status: Status, metrics?: Record<string, number>) => update(id, (previous) => previous.map((message) =>
      message.id.startsWith(active.id) ? { ...message, status, ...(message.role === 'assistant' && metrics ? { metrics } : {}) } : message))
    try {
      const response = await fetch(`${HTTP_URL}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ request_id: active.id, conversation_id: id, messages: [{ role: 'user', content }] }),
        signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(190000)]),
      })
      if (!response.ok) {
        const refusals: Record<number, string> = {
          409: 'This conversation is already generating. Wait, then try again.',
          429: 'Generation capacity is busy. Wait for another conversation to finish, then try again.',
          403: 'The chat session expired. Reconnect before sending again.',
          404: 'This conversation was deleted. Your unsent text is retained locally.',
          503: 'Conversation storage is busy. Your draft is retained; try again later.',
          422: 'The message or conversation is too large. Shorten your text and try again.',
        }
        throw new Error(refusals[response.status] ?? `Chat request failed (${response.status}).`)
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
          removePending(active.id)
          // The history captured before acceptance is authoritative. Ignore WS reloads
          // racing chat.started (which already contain the newly accepted messages).
          update(id, () => [...(details[id]?.messages ?? []).filter((message) => message.request_id !== active.id),
            { id: `${active.id}-user`, request_id: active.id, role: 'user', content, status: 'complete', metrics: null, created_at: new Date().toISOString() },
            { id: `${active.id}-assistant`, request_id: active.id, role: 'assistant', content: '', status: 'streaming', metrics: null, created_at: new Date().toISOString() },
          ])
          onAccepted()
        } else if (event.type === 'chat.delta') {
          if (!accepted) throw new Error('The backend sent text before accepting the message.')
          update(id, (previous) => previous.map((message) => message.id === `${active.id}-assistant` ? { ...message, content: message.content + event.text } : message))
        } else if (event.type === 'chat.done') {
          if (!accepted) throw new Error('The backend completed a message it never accepted.')
          terminal = true; mark('complete', event.metrics)
        } else if (event.type === 'chat.cancelled') {
          terminal = true; active.stopped = true; mark('cancelled')
        } else throw new Error(event.message)
      }
      while (!active.stopped && !terminal) {
        const { value, done } = await reader.read()
        if (active.stopped) break
        buffer += decoder.decode(value, { stream: !done })
        if (buffer.length > 262144) throw new Error('The backend returned an oversized chat event.')
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); consume(line)
        }
        if (done) { if (buffer.trim()) consume(buffer); break }
      }
      if (!terminal && !active.stopped) throw new Error('The response was interrupted. Any partial reply has been kept.')
      if (active.stopped && accepted) mark('cancelled')
    } catch (failure) {
      if (accepted) mark(active.stopped ? 'cancelled' : 'failed')
      else fail(active.id)
      if (!active.stopped) setError(failure instanceof Error ? failure.message : 'Chat failed. Try again.')
    } finally {
      if (!accepted && active.stopped) fail(active.id)
      await active.reader?.cancel().catch(() => undefined)
      // Keep the overlay until a post-stream authoritative reload completes.
      const beforeReload = library.getSnapshot().historyRevisions[id] ?? 0
      if (accepted) await library.load(id)
      if (accepted && (library.getSnapshot().historyRevisions[id] ?? 0) > beforeReload) {
        const next = { ...history.current }; delete next[id]; history.current = next
        if (mounted.current) setLive(next)
      }
      runs.current.delete(id)
      if (mounted.current) setBusyIds(new Set(runs.current.keys()))
    }
  }
  const savedMessages = selectedId ? live[selectedId] ?? details[selectedId]?.messages ?? [] : []
  const messages: ChatViewMessage[] = [
    ...savedMessages.map((message) => ({ ...message, id: message.request_id ? `${message.request_id}-${message.role}` : message.id })),
    ...pending.filter((item) => item.conversationId === selectedId && !savedMessages.some((message) => message.request_id === item.id)).map((item): ChatViewMessage => ({
      id: `${item.id}-user`, role: 'user', content: item.text.trim(), status: 'complete', metrics: null,
      created_at: item.createdAt, delivery: item.delivery, pendingSend: item,
    })),
  ]
  const ownedBusy = selectedId ? busyIds.has(selectedId) : false
  const busy = ownedBusy || messages.some((message) => message.status === 'streaming')
  return { messages, busy, ownedBusy, error: selectedId ? errors[selectedId] : null, send, prepare, attach, fail,
    stop: () => { const active = selectedId ? runs.current.get(selectedId) : undefined; if (active) void stopRun(active) },
  }
}
