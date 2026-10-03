import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { initialState } from '@/test/backend-fixture'

class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null

  closed = false
  autoPong = true
  autoAck = true
  sent: string[] = []
  send(data: string) {
    if (this.closed) throw new Error('Socket closed')
    this.sent.push(data)
    const message = JSON.parse(data)
    if (message.type === 'session.ping' && this.autoPong) this.emit({ type: 'session.pong', id: message.id })
    if (message.type === 'transcript.ack' && this.autoAck) this.emit({ type: 'transcript.acknowledged', recording_id: message.recording_id, conversation_id: message.conversation_id })
  }
  constructor() { FakeSocket.instances.push(this) }
  close() { this.closed = true; this.onclose?.({ code: 1000 }) }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

function socket() { return FakeSocket.instances[FakeSocket.instances.length - 1] }
function connect() {
  act(() => socket().emit({ type: 'session.ready', session_id: 'test-session', state: initialState }))
}

const defaultFetch: typeof fetch = async (_url, init) => init?.method === 'POST'
  ? new Response(null, { status: 202 })
  : Response.json({ ...initialState, ui_connected: false })
const fetchMock = vi.fn<typeof fetch>(defaultFetch)

beforeEach(() => {
  FakeSocket.instances = []
  fetchMock.mockReset().mockImplementation(defaultFetch)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.useRealTimers())

describe('voice-first UI', () => {
  it('sends reviewed text to Gemma, renders the reply and clears only the sent draft', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const body = JSON.parse(String(init?.body))
        return new Response([
          { type: 'chat.started', request_id: body.request_id, model: 'gemma3:4b', context_tokens: 4096 },
          { type: 'chat.delta', request_id: body.request_id, text: 'Hello from Gemma.' },
          { type: 'chat.done', request_id: body.request_id, metrics: { output_tokens: 5, elapsed_seconds: 1 } },
        ].map((event) => JSON.stringify(event)).join('\n') + '\n')
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello Gemma' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Hello from Gemma.')
    expect(screen.getByText('Hello Gemma')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat'))
    expect(JSON.parse(String(request?.[1]?.body)).messages).toEqual([{ role: 'user', content: 'Hello Gemma' }])
  })

  it('keeps the draft and recording connection when Ollama cannot start', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const { request_id } = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ type: 'chat.error', request_id, message: 'Cannot reach Ollama. Start it with: ollama serve' }) + '\n')
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    const owner = socket()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText(/Cannot reach Ollama/)
    expect(screen.getByRole('textbox')).toHaveValue('Keep my question')
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeEnabled()
    expect(owner.closed).toBe(false)
  })

  it('stops generation, keeps partial text and sends only completed turns next time', async () => {
    let requests = 0
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const { request_id } = JSON.parse(String(init?.body))
        requests++
        if (requests === 1) {
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode([
              { type: 'chat.started', request_id }, { type: 'chat.delta', request_id, text: 'Partial reply' },
            ].map((event) => JSON.stringify(event)).join('\n') + '\n'))
          } }))
        }
        return new Response([
          { type: 'chat.started', request_id }, { type: 'chat.delta', request_id, text: 'Finished reply' },
          { type: 'chat.done', request_id, metrics: { elapsed_seconds: 1 } },
        ].map((event) => JSON.stringify(event)).join('\n') + '\n')
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Partial reply')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
    await screen.findByText('Stopped · partial reply')
    expect(screen.getByRole('textbox')).toHaveValue('Next question')
    expect(screen.getByText('Partial reply')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Finished reply')
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat'))
    expect(JSON.parse(String(calls[1][1]?.body)).messages).toEqual([{ role: 'user', content: 'Next question' }])
  })

  it('preserves edits made while Ollama is starting', async () => {
    let accept: (() => void) | undefined
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const { request_id } = JSON.parse(String(init?.body))
        return new Response(new ReadableStream({ start(controller) {
          accept = () => {
            controller.enqueue(new TextEncoder().encode([
              { type: 'chat.started', request_id }, { type: 'chat.delta', request_id, text: 'Reply after loading' },
              { type: 'chat.done', request_id, metrics: { elapsed_seconds: 1 } },
            ].map((event) => JSON.stringify(event)).join('\n') + '\n'))
            controller.close()
          }
        } }))
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Sent text' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New edits while loading' } })
    act(() => accept?.())
    await screen.findByText('Reply after loading')
    expect(screen.getByRole('textbox')).toHaveValue('New edits while loading')
  })

  it('decodes Unicode replies split across individual bytes and accepts a final line without newline', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const { request_id } = JSON.parse(String(init?.body))
        const bytes = new TextEncoder().encode([
          { type: 'chat.started', request_id },
          { type: 'chat.delta', request_id, text: 'Hello 👋 — こんにちは' },
          { type: 'chat.done', request_id, metrics: { elapsed_seconds: 0.1 } },
        ].map((event) => JSON.stringify(event)).join('\n'))
        return new Response(new ReadableStream({ start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        } }))
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unicode question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Hello 👋 — こんにちは')
    await screen.findByText('0.1s')
    expect(screen.queryByText('Chat could not finish')).not.toBeInTheDocument()
  })

  it('keeps interrupted replies visible but excludes them from the next request', async () => {
    let calls = 0
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/chat')) {
        const { request_id } = JSON.parse(String(init?.body))
        calls++
        const events = [
          { type: 'chat.started', request_id },
          { type: 'chat.delta', request_id, text: calls === 1 ? 'Interrupted text' : 'Complete text' },
        ]
        const encoded = events.map((event) => JSON.stringify(event))
        if (calls > 1) encoded.push(JSON.stringify({ type: 'chat.done', request_id, metrics: { elapsed_seconds: 1 } }))
        return new Response(encoded.join('\n') + '\n')
      }
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First message' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Failed · partial reply')
    expect(screen.getByText('Interrupted text')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use this text again' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retry question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Complete text')
    const requests = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat'))
    expect(JSON.parse(String(requests[1][1]?.body)).messages).toEqual([{ role: 'user', content: 'Retry question' }])
  })

  it('keeps the composer usable while disconnected and disables recording', async () => {
    render(<App />)
    act(() => socket().close())
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    expect(screen.getByText('uv run outloud')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your text' }), 'Draft without a backend')
    expect(screen.getByRole('textbox')).toHaveValue('Draft without a backend')
    expect(screen.getByRole('button', { name: /Send message/ })).toBeDisabled()
  })

  it('does not lose a held pointer when the pending start reserves the final slot', async () => {
    render(<App />)
    connect()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to record' }), { button: 0, pointerId: 7 })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const reserved = { ...initialState, capacity: { limit: 3, used: 3, available: 0 } }
    act(() => socket().emit({ type: 'state.updated', state: { ...reserved, revision: 2, pending_commands: 1 } }))
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeEnabled()
    act(() => socket().emit({ type: 'state.updated', state: { ...reserved, revision: 3, recording: true } }))
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Release to stop' }), { button: 0, pointerId: 7 })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/recording/release'), expect.anything()))
  })

  it('bounds unconfirmed acknowledgements and drains them as confirmations arrive', () => {
    render(<App />)
    connect()
    const owner = socket()
    owner.autoAck = false
    for (let index = 0; index < 20; index++) {
      act(() => owner.emit({ type: 'transcription.completed', recording_id: `recording-${index}`, conversation_id: 'local-draft', text: `Line ${index}` }))
    }
    const acknowledgements = () => owner.sent.map((value) => JSON.parse(value)).filter((event) => event.type === 'transcript.ack')
    expect(acknowledgements()).toHaveLength(16)
    expect(screen.getByDisplayValue(/Line 19/)).toBeInTheDocument()
    act(() => owner.emit({ type: 'transcript.acknowledged', recording_id: 'recording-0', conversation_id: 'local-draft' }))
    expect(acknowledgements()).toHaveLength(17)
    expect(acknowledgements().at(-1).recording_id).toBe('recording-16')
    expect(owner.closed).toBe(false)
  })

  it('retries the bounded acknowledgement backlog after reconnect', async () => {
    render(<App />)
    connect()
    socket().autoAck = false
    for (let index = 0; index < 20; index++) {
      act(() => socket().emit({ type: 'transcription.completed', recording_id: `retry-${index}`, conversation_id: 'local-draft', text: 'Saved' }))
    }
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    const replacement = socket()
    replacement.autoAck = false
    connect()
    const acknowledgements = () => replacement.sent.map((value) => JSON.parse(value)).filter((event) => event.type === 'transcript.ack')
    expect(acknowledgements()).toHaveLength(16)
    act(() => replacement.emit({ type: 'transcript.acknowledged', recording_id: 'retry-0', conversation_id: 'local-draft' }))
    expect(acknowledgements()).toHaveLength(17)
    expect(acknowledgements().at(-1).recording_id).toBe('retry-16')
    expect(screen.getByDisplayValue(/Saved/)).toBeInTheDocument()
  })

  it('keeps the owner connected after a capacity rejection and permits retry', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'Transcription capacity is full.' }, { status: 429 }))
    render(<App />)
    connect()
    const owner = socket()
    fireEvent.click(screen.getByRole('button', { name: 'Record hands-free' }))
    await screen.findByText(/Transcription capacity is full/)
    expect(owner.closed).toBe(false)
    expect(screen.getByText('Connected · local')).toBeInTheDocument()
    expect(screen.queryByText('Backend confirmed recording stopped')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Record hands-free' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows full capacity, blocks new starts, preserves the draft and keeps Stop available', () => {
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
    const full = { ...initialState, revision: 2, capacity: { limit: 3, used: 3, available: 0 } }
    act(() => socket().emit({ type: 'state.updated', state: full }))
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Record hands-free' })).toBeDisabled()
    expect(screen.getByText(/3 of 3 transcription slots used/)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
    act(() => socket().emit({ type: 'state.updated', state: { ...full, revision: 3, recording: true, hands_free: true } }))
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('enables retry after connection timeout without losing the draft', async () => {
    vi.useFakeTimers()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    connect()
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeEnabled()
  })

  it('shows initial recording and transcription failures without treating history as current unavailability', () => {
    const { container } = render(<App />)
    const errors = {
      recording: { recording_id: null, conversation_id: 'local-draft', message: 'Earlier recording failed.', occurred_at: '2026-04-15T12:30:00.123456+00:00' },
      transcription: { recording_id: 'recording-previous', conversation_id: 'local-draft', message: 'Earlier transcription failed.', occurred_at: '2026-04-15T12:31:00+00:00' },
    }
    act(() => socket().emit({ type: 'session.ready', session_id: 'session', state: { ...initialState, errors } }))
    expect(screen.getByText('Previous recording error')).toBeInTheDocument()
    expect(screen.getByText('Previous transcription error')).toBeInTheDocument()
    expect(screen.getByText('Earlier recording failed.')).toBeInTheDocument()
    expect(screen.getByText('recording-previous')).toBeInTheDocument()
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(errors.recording.occurred_at)
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeEnabled()
    expect(screen.queryByText('Recording backend is unavailable')).not.toBeInTheDocument()
  })

  it('keeps a dismissed historical failure dismissed across state updates and reconnect', async () => {
    render(<App />)
    const errors = {
      recording: null,
      transcription: { recording_id: 'recording-previous', conversation_id: 'local-draft', message: 'Earlier transcription failed.', occurred_at: '2026-04-15T12:31:00Z' },
    }
    act(() => socket().emit({ type: 'session.ready', session_id: 'session', state: { ...initialState, errors } }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss previous transcription error' }))
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, errors } }))
    expect(screen.queryByText('Previous transcription error')).not.toBeInTheDocument()
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    act(() => socket().emit({ type: 'session.ready', session_id: 'new-session', state: { ...initialState, errors } }))
    expect(screen.queryByText('Previous transcription error')).not.toBeInTheDocument()
    act(() => socket().emit({ type: 'transcription.error', message: 'Earlier transcription failed.' }))
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('Earlier transcription failed.')).toBeInTheDocument()
  })

  it('shows a different failure on reconnect even after an older failure was dismissed', async () => {
    render(<App />)
    const failure = { recording_id: 'recording-previous', conversation_id: 'local-draft', message: 'Earlier transcription failed.', occurred_at: '2026-04-15T12:31:00Z' }
    act(() => socket().emit({ type: 'session.ready', session_id: 'session', state: { ...initialState, errors: { recording: null, transcription: failure } } }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss previous transcription error' }))
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    act(() => socket().emit({
      type: 'session.ready', session_id: 'new-session',
      state: { ...initialState, errors: { recording: null, transcription: { ...failure, recording_id: 'recording-new', occurred_at: '2026-04-15T12:32:00Z' } } },
    }))
    expect(screen.getByText('Previous transcription error')).toBeInTheDocument()
    expect(screen.getByText('recording-new')).toBeInTheDocument()
  })

  it('appends a transcript without replacing typed text or inserting duplicates', async () => {
    render(<App />)
    connect()
    await userEvent.type(screen.getByRole('textbox'), 'Typed draft')
    const event = { type: 'transcription.completed', recording_id: 'recording-1', conversation_id: 'local-draft', text: 'Spoken words.' }
    act(() => { socket().emit(event); socket().emit(event) })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Typed draft\nSpoken words.'))
    act(() => socket().emit({ ...event, recording_id: 'other', conversation_id: 'another-conversation' }))
    expect(screen.getByRole('textbox')).toHaveValue('Typed draft\nSpoken words.')
  })

  it('acknowledges only after transcripts are committed to the composer, including empty results', async () => {
    render(<App />)
    connect()
    await userEvent.type(screen.getByRole('textbox'), 'Typed')
    const owner = socket()
    const send = owner.send.bind(owner)
    vi.spyOn(owner, 'send').mockImplementation((data) => {
      const message = JSON.parse(data)
      if (message.type === 'transcript.ack') expect(screen.getByRole('textbox')).toHaveValue('Typed\nSpoken')
      send(data)
    })
    act(() => {
      owner.emit({ type: 'transcription.completed', recording_id: 'one', conversation_id: 'local-draft', text: 'Spoken' })
      owner.emit({ type: 'transcription.completed', recording_id: 'empty', conversation_id: 'local-draft', text: '' })
    })
    await waitFor(() => expect(owner.sent.map((data) => JSON.parse(data)).filter((message) => message.type === 'transcript.ack').map((message) => message.recording_id)).toEqual(['one', 'empty']))
  })

  it('retries a lost acknowledgement after reconnect without restoring text the user edited away', async () => {
    render(<App />)
    connect()
    const owner = socket()
    owner.autoAck = false
    const transcript = { type: 'transcription.completed', recording_id: 'one', conversation_id: 'local-draft', text: 'Spoken' }
    act(() => owner.emit(transcript))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Spoken'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited instead' } })
    act(() => owner.close())
    await screen.findByText('Backend confirmed recording stopped')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    act(() => socket().emit({ type: 'session.ready', session_id: 'replacement', state: initialState }))
    expect(socket().sent.map((data) => JSON.parse(data)).filter((message) => message.type === 'transcript.ack')).toHaveLength(1)
    act(() => socket().emit(transcript))
    expect(screen.getByRole('textbox')).toHaveValue('Edited instead')
    expect(socket().sent.map((data) => JSON.parse(data)).filter((message) => message.type === 'transcript.ack')).toHaveLength(2)
  })

  it('appends a missed replay to the preserved draft and ignores other conversations', async () => {
    render(<App />)
    connect()
    await userEvent.type(screen.getByRole('textbox'), 'Preserved')
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    connect()
    act(() => {
      socket().emit({ type: 'transcription.completed', recording_id: 'missed', conversation_id: 'local-draft', text: 'Offline words' })
      socket().emit({ type: 'transcription.completed', recording_id: 'other', conversation_id: 'other-chat', text: 'Not here' })
    })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Preserved\nOffline words'))
    expect(socket().sent.map((data) => JSON.parse(data)).filter((message) => message.type === 'transcript.ack').map((message) => message.recording_id)).toEqual(['missed'])
  })

  it('preserves the appended draft and closes safely when acknowledgement sending fails', async () => {
    render(<App />)
    connect()
    const owner = socket()
    vi.spyOn(owner, 'send').mockImplementation(() => { throw new Error('socket failed') })
    act(() => owner.emit({ type: 'transcription.completed', recording_id: 'one', conversation_id: 'local-draft', text: 'Keep these words' }))
    await screen.findByText('Backend confirmed recording stopped')
    expect(owner.closed).toBe(true)
    expect(screen.getByRole('textbox')).toHaveValue('Keep these words')
  })

  it('sends hold/release commands in order with the owner token', async () => {
    render(<App />)
    connect()
    const button = screen.getByRole('button', { name: 'Hold to record' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyDown(button, { key: ' ', repeat: true })
    fireEvent.keyUp(button, { key: ' ' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8765/recording/press')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:8765/recording/release')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-Session-ID': 'test-session' },
      body: JSON.stringify({ conversation_id: 'local-draft' }),
    })
  })

  it('provides an accessible hands-free action', async () => {
    render(<App />)
    connect()
    await userEvent.click(screen.getByRole('button', { name: 'Record hands-free' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8765/recording/hands-free')
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ conversation_id: 'local-draft' }))
  })

  it('shows pending commands while still allowing the matching release', async () => {
    let acceptPress: (response: Response) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { acceptPress = resolve }))
    render(<App />)
    connect()
    const button = screen.getByRole('button', { name: 'Hold to record' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyUp(button, { key: ' ' })
    expect(screen.getByText('Sending recording controls…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { acceptPress(new Response(null, { status: 202 })) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Sending recording controls…')).not.toBeInTheDocument())
  })

  it('treats a connection.error event as fatal even before the socket closes', async () => {
    render(<App />)
    connect()
    const owner = socket()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } })
    act(() => owner.emit({ type: 'connection.error', message: 'Client could not keep up; reconnect.' }))
    await screen.findByText('Backend confirmed recording stopped')
    expect(owner.closed).toBe(true)
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft')
    expect(screen.getByText('Client could not keep up; reconnect.')).toBeInTheDocument()
  })

  it('closes the session after a failed release and drops queued presses', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/release')) throw new TypeError('Network request failed')
      return defaultFetch(url, init)
    })
    render(<App />)
    connect()
    const owner = socket()
    const button = screen.getByRole('button', { name: 'Hold to record' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyUp(button, { key: ' ' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyUp(button, { key: ' ' })
    await screen.findByText('Backend confirmed recording stopped')
    expect(owner.closed).toBe(true)
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => call[0])).toEqual([
      'http://127.0.0.1:8765/recording/press',
      'http://127.0.0.1:8765/recording/release',
    ])
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    expect(screen.getByText('Network request failed')).toBeInTheDocument()
  })

  it.each([403, 503, 500, 'timeout'] as const)('closes the owner session on %s command failure', async (failure) => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method !== 'POST') return defaultFetch(url, init)
      if (failure === 'timeout') throw new DOMException('Request timed out', 'TimeoutError')
      return new Response(null, { status: failure })
    })
    render(<App />)
    connect()
    const owner = socket()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to record' }), { key: ' ' })
    await screen.findByText('Backend confirmed recording stopped')
    expect(owner.closed).toBe(true)
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
  })

  it('does not claim recording stopped when the backend cannot confirm it', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('Backend unreachable') })
    render(<App />)
    connect()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to record' }), { key: ' ' })
    expect(await screen.findByText('Recording stop is unconfirmed', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('Backend confirmed recording stopped')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(await screen.findByText('Recording stop is unconfirmed', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('recovers from disconnect while holding and requires a fresh press after reconnect', async () => {
    render(<App />)
    connect()
    const button = screen.getByRole('button', { name: 'Hold to record' })
    fireEvent.keyDown(button, { key: ' ' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    fireEvent.keyUp(button, { key: ' ' })
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    act(() => socket().emit({ type: 'session.ready', session_id: 'new-session', state: initialState }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to record' }), { key: ' ' })
    fireEvent.keyUp(screen.getByRole('button', { name: 'Hold to record' }), { key: ' ' })
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(3))
    const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')
    expect(posts[1]?.[1]?.headers).toMatchObject({ 'X-Session-ID': 'new-session' })
  })

  it('ignores older snapshots and shows backend errors', () => {
    render(<App />)
    connect()
    act(() => {
      socket().emit({ type: 'state.updated', state: { ...initialState, revision: 3, recording: true, recording_id: 'recording-1' } })
      socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2 } })
    })
    expect(screen.getByRole('button', { name: 'Release to stop' })).toBeInTheDocument()
    act(() => socket().emit({ type: 'recording.error', message: 'Microphone permission denied.' }))
    expect(screen.getByText('Microphone permission denied.')).toBeInTheDocument()
  })

  it('keeps Fn off by default and enables it only through the owner endpoint', async () => {
    render(<App />)
    const toggle = screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()
    connect()
    expect(toggle).toBeEnabled()
    await userEvent.click(toggle)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8765/shortcuts/fn')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-Session-ID': 'test-session' },
      body: JSON.stringify({ enabled: true, conversation_id: 'local-draft' }),
    })
    // HTTP acceptance is not confirmation that the native listener started.
    expect(toggle).not.toBeChecked()
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, fn_shortcut: { status: 'starting', error: null } } }))
    expect(toggle).toBeChecked()
    expect(screen.getByText(/Enabling keyboard capture/)).toBeInTheDocument()
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 3, fn_shortcut: { status: 'enabled', error: null } } }))
    expect(toggle).toBeChecked()
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ enabled: false, conversation_id: 'local-draft' }))
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 4 } }))
    expect(toggle).not.toBeChecked()
  })

  it('shows Fn permission errors without disabling on-screen recording or losing text', () => {
    render(<App />)
    connect()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } })
    act(() => socket().emit({
      type: 'state.updated',
      state: { ...initialState, revision: 2, fn_shortcut: { status: 'failed', error: 'Allow Accessibility for your terminal, then restart the backend.' } },
    }))
    expect(screen.getByRole('alert')).toHaveTextContent('Allow Accessibility')
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeEnabled()
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft')
  })

  it('reflects Fn recording in the same controls and stops it from the UI', async () => {
    render(<App />)
    connect()
    act(() => socket().emit({
      type: 'state.updated',
      state: { ...initialState, revision: 2, recording: true, hands_free: true, recording_id: 'fn-recording', fn_shortcut: { status: 'enabled', error: null } },
    }))
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8765/recording/stop'))
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 3, fn_shortcut: { status: 'enabled', error: null } } }))
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).toBeChecked()
  })

  it('resets Fn on reconnect without automatically opting the new session in', async () => {
    render(<App />)
    connect()
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, fn_shortcut: { status: 'enabled', error: null } } }))
    act(() => socket().close())
    await screen.findByText('Backend confirmed recording stopped')
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    act(() => socket().emit({ type: 'session.ready', session_id: 'new-session', state: initialState }))
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).not.toBeChecked()
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0)
  })

  it('allows disabling Fn during microphone startup', async () => {
    render(<App />)
    connect()
    act(() => socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, pending_commands: 1, fn_shortcut: { status: 'enabled', error: null } } }))
    const toggle = screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })
    expect(toggle).toBeEnabled()
    await userEvent.click(toggle)
    await waitFor(() => expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ enabled: false, conversation_id: 'local-draft' })))
  })

  it('closes the owner session if a shortcut command fails', async () => {
    fetchMock.mockImplementation(async (url, init) => init?.method === 'POST'
      ? new Response(null, { status: 403 })
      : defaultFetch(url, init))
    render(<App />)
    connect()
    const owner = socket()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' }))
    await screen.findByText('Backend confirmed recording stopped')
    expect(owner.closed).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Enable Fn shortcut' })).toBeDisabled()
  })

  it('explains when another tab owns the session', () => {
    render(<App />)
    act(() => socket().onclose?.({ code: 1008 }))
    expect(screen.getByText('Another tab is using the microphone session')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })
})
