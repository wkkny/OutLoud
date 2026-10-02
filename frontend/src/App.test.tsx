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
  it('keeps the composer usable while disconnected and disables recording', async () => {
    render(<App />)
    act(() => socket().close())
    expect(screen.getByRole('button', { name: 'Hold to record' })).toBeDisabled()
    expect(screen.getByText('uv run outloud')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your text' }), 'Draft without a backend')
    expect(screen.getByRole('textbox')).toHaveValue('Draft without a backend')
    expect(screen.getByRole('button', { name: /Send message/ })).toBeDisabled()
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

  it('explains when another tab owns the session', () => {
    render(<App />)
    act(() => socket().onclose?.({ code: 1008 }))
    expect(screen.getByText('Another tab is using the microphone session')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })
})
