import { vi } from 'vitest'
import type { Snapshot } from '@/lib/protocol'

export const initialState: Snapshot = {
  revision: 1, pending_commands: 0,
  capacity: { limit: 3, used: 0, available: 3 },
  fn_shortcut: { status: 'disabled', error: null },
  recording: false, capture_owned: false, client_connected: true, hands_free: false, recording_id: null, conversation_id: null,
  ready: true, errors: { recording: null, transcription: null }, shutting_down: false,
  ui_connected: true,
  transcription: { status: 'idle', active_job: null, queued_jobs: [] },
  workers: { recording: { status: 'running', error: null }, transcription: { status: 'running', error: null } },
}

export class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  sent: Record<string, unknown>[] = []
  readonly url: string
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this) }
  send(data: string) {
    if (this.closed) throw new Error('Socket closed')
    const message = JSON.parse(data)
    this.sent.push(message)
    if (message.type === 'session.ping') this.emit({ type: 'session.pong', id: message.id })
    if (message.type === 'transcript.ack') this.emit({ ...message, type: 'transcript.acknowledged' })
  }
  close() { this.closed = true; this.onclose?.() }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
  ready(state = {}) { this.emit({ type: 'session.ready', session_id: 'test-session', state: { ...initialState, capture_owned: false, client_connected: true, ...state } }) }
}

export function backendFixture() {
  FakeSocket.instances = []
  let nextId = 2
  // Mutations get increasing timestamps, like the backend's updated_at writes.
  let tick = 0
  const stamp = () => `2026-01-01T00:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}Z`
  const conversations = new Map([
    ['chat-1', { id: 'chat-1', title: 'First chat', draft: 'Saved words', draft_version: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [] as unknown[] }],
  ])
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
  let chatStatus = 200
  let manualChats = false
  const streams = new Map<string, { requestId: string; controller: ReadableStreamDefaultController<Uint8Array>; conversation: { updated_at: string }; assistant: { id: string; role: string; content: string; status: string; metrics: Record<string, number> | null; created_at: string } }>()
  const emitChat = (id: string, event: Record<string, unknown>) => {
    const stream = streams.get(id)!
    stream.controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...event, request_id: stream.requestId }) + '\n'))
  }
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ path, method, body })
    if (path === '/state') return Response.json({ ...initialState, capture_owned: false, client_connected: false })
    if (path === '/conversations') {
      if (method === 'POST') {
        const id = `chat-${nextId++}`
        const conversation = { ...conversations.get('chat-1')!, id, title: body.title ?? 'New conversation', draft: '', draft_version: 0, created_at: stamp(), updated_at: stamp(), messages: [] }
        conversations.set(id, conversation)
        return Response.json(conversation, { status: 201 })
      }
      return Response.json([...conversations.values()])
    }
    if (path.startsWith('/conversations/')) {
      const id = decodeURIComponent(path.split('/')[2]!)
      const conversation = conversations.get(id)
      if (!conversation) return Response.json({ detail: 'Conversation deleted' }, { status: 404 })
      if (method === 'DELETE') { conversations.delete(id); return new Response(null, { status: 204 }) }
      if (method === 'PATCH') {
        if ('draft' in body && body.draft_version !== conversation.draft_version) return Response.json({ detail: 'Draft version conflict' }, { status: 409 })
        if ('draft' in body) { conversation.draft = String(body.draft); conversation.draft_version++ }
        if ('title' in body) conversation.title = String(body.title)
        if ('draft' in body || 'title' in body) conversation.updated_at = stamp()
      }
      return Response.json(conversation)
    }
    if (path === '/chat/cancel') {
      const stream = [...streams.values()].find((item) => item.requestId === body.request_id)
      if (stream) stream.assistant.status = 'cancelled'
      return new Response(null, { status: 202 })
    }
    if (path === '/chat') {
      if (chatStatus !== 200) return Response.json({ detail: 'Busy' }, { status: chatStatus })
      const conversation = conversations.get(String(body.conversation_id))!
      const accepted = conversation.messages as { request_id?: string; role: string; content: string; status: string; metrics: Record<string, number> | null }[]
      const existing = accepted.find((message) => message.request_id === body.request_id && message.role === 'assistant')
      if (existing) return new Response([
        { type: 'chat.started', request_id: body.request_id },
        ...(existing.content ? [{ type: 'chat.delta', request_id: body.request_id, text: existing.content }] : []),
        existing.status === 'complete'
          ? { type: 'chat.done', request_id: body.request_id, metrics: existing.metrics ?? { elapsed_seconds: 0 } }
          : { type: 'chat.error', request_id: body.request_id, message: 'This message was already saved. Its partial reply has been kept.' },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n')
      const assistant = { id: `${body.request_id}-assistant`, request_id: body.request_id, role: 'assistant', content: manualChats ? '' : 'Local reply', status: manualChats ? 'streaming' : 'complete', metrics: manualChats ? null : { elapsed_seconds: 1 }, created_at: '2026-01-01T00:00:00Z' }
      conversation.messages.push(
        { id: `${body.request_id}-user`, request_id: body.request_id, role: 'user', content: body.messages[0].content, status: 'complete', metrics: null, created_at: '2026-01-01T00:00:00Z' }, assistant,
      )
      conversation.updated_at = stamp()
      if (manualChats) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.set(conversation.id, { requestId: String(body.request_id), controller, conversation, assistant })
          emitChat(conversation.id, { type: 'chat.started' })
        },
      }))
      const events = [
        { type: 'chat.started', request_id: body.request_id },
        { type: 'chat.delta', request_id: body.request_id, text: 'Local reply' },
        { type: 'chat.done', request_id: body.request_id, metrics: { elapsed_seconds: 1 } },
      ]
      return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    }
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeSocket)
  return {
    conversations, requests, fetchMock,
    setChatStatus: (status: number) => { chatStatus = status },
    holdChats: () => { manualChats = true },
    delta: (id: string, text: string) => { streams.get(id)!.assistant.content += text; emitChat(id, { type: 'chat.delta', text }) },
    done: (id: string) => {
      const stream = streams.get(id)!
      stream.assistant.status = 'complete'; stream.assistant.metrics = { elapsed_seconds: 1 }
      stream.conversation.updated_at = stamp()
      emitChat(id, { type: 'chat.done', metrics: { elapsed_seconds: 1 } }); stream.controller.close()
    },
    interrupt: (id: string) => { streams.get(id)!.controller.close() },
    socket: () => FakeSocket.instances.at(-1)!,
  }
}
