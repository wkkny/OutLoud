import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, FakeSocket, initialState } from '@/test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
beforeEach(() => { vi.useRealTimers(); sessionStorage.clear(); backend = backendFixture() })
async function open() {
  const view = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
  return view
}

it('creates, selects, renames, deletes and restores durable conversations independently of the socket', async () => {
  const view = await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Ideas' } })
  fireEvent.click(screen.getByRole('button', { name: 'Rename conversation' }))
  await screen.findByRole('button', { name: 'Select Ideas' })
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words'))
  expect(backend.socket().closed).toBe(false)
  expect(backend.socket().url).toBe('ws://127.0.0.1:8765/events')
  view.unmount()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'Select Ideas' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Ideas' })).not.toBeInTheDocument())
})

it('rebases unsaved edits on atomic remote dictation without appending the transcript twice', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Edited words' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'Saved words\nDictated words'; saved.draft_version++
  act(() => {
    backend.socket().emit({ type: 'transcription.completed', recording_id: 'r1', conversation_id: 'chat-1', text: 'Dictated words' })
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
  })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Edited words\nDictated words'))
  await waitFor(() => expect(backend.socket().sent).toContainEqual({ type: 'transcript.ack', recording_id: 'r1', conversation_id: 'chat-1' }))
  await waitFor(() => expect(saved.draft).toBe('Edited words\nDictated words'))
  act(() => backend.socket().emit({ type: 'transcription.completed', recording_id: 'r1', conversation_id: 'chat-1', text: 'Dictated words' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Edited words\nDictated words')
})

it('preserves both drafts when a version conflict cannot merge, and allows deliberate resolution', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'My local edit' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'Other tab replacement'; saved.draft_version++
  await screen.findByText('Draft conflict')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('My local edit')
  expect(screen.getByText('Other tab replacement')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep both drafts' }))
  await waitFor(() => expect(saved.draft).toBe('My local edit\nOther tab replacement'))
})

it('toggles capture on clicks only, keeps the recording owner connected while switching, and routes dictation to its origin', async () => {
  await open()
  const mic = screen.getByRole('button', { name: 'Start recording' })
  fireEvent.pointerDown(mic); fireEvent.pointerUp(mic)
  expect(backend.requests.filter((request) => request.path.startsWith('/recording/'))).toHaveLength(0)
  fireEvent.click(mic)
  await waitFor(() => expect(backend.requests).toContainEqual({ path: '/recording/start', method: 'POST', body: { conversation_id: 'chat-1' } }))
  const owner = backend.socket()
  act(() => owner.emit({ type: 'state.updated', state: { ...initialState, revision: 2, capture_owned: true, client_connected: true, recording: true, conversation_id: 'chat-1' } }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(owner.closed).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
  await waitFor(() => expect(backend.requests).toContainEqual({ path: '/recording/stop', method: 'POST', body: {} }))
  const origin = backend.conversations.get('chat-1')!
  origin.draft = 'Saved words\nOld capture'; origin.draft_version++
  act(() => owner.emit({ type: 'transcription.completed', recording_id: 'old', conversation_id: 'chat-1', text: 'Old capture' }))
  await waitFor(() => expect(owner.sent).toContainEqual({ type: 'transcript.ack', recording_id: 'old', conversation_id: 'chat-1' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words\nOld capture'))
  expect(screen.queryByText(/Fn|Hold to|hands-free/)).not.toBeInTheDocument()
})

it('shows app-wide microphone occupancy without rejecting the tab connection', async () => {
  await open()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, capture_owned: false, client_connected: true, recording: true, conversation_id: 'elsewhere' } }))
  expect(screen.getByText('Microphone occupied in another tab')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  expect(screen.getByText('Connected · local')).toBeInTheDocument()
})

it('sends only the latest user message with backend identity, displays the reply and clears the accepted draft', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.find((request) => request.path === '/chat')?.body).toMatchObject({ conversation_id: 'chat-1', messages: [{ role: 'user', content: 'Saved words' }] })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(backend.conversations.get('chat-1')?.draft).toBe('')
})

it.each([[429, 'Generation capacity is busy'], [409, 'This conversation is already generating'], [503, 'Conversation storage is busy'], [403, 'The chat session expired'], [404, 'This conversation was deleted']])('keeps the draft and reports a %s refusal without retrying the model', async (status, message) => {
  await open()
  backend.setChatStatus(Number(status))
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText(String(message), { exact: false })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(1)
  expect(screen.queryByText('Local reply')).not.toBeInTheDocument()
})

it('backs off failed initial connections, exhausts a bounded retry budget and retains tab selection and unsaved text across reload', async () => {
  vi.useFakeTimers()
  const view = render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Offline edits' } })
  for (const delay of [500, 1000, 2000, 4000]) {
    act(() => backend.socket().onerror?.())
    const count = FakeSocket.instances.length
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
    expect(FakeSocket.instances).toHaveLength(count)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(FakeSocket.instances).toHaveLength(count + 1)
  }
  act(() => backend.socket().onerror?.())
  expect(screen.getByText('Connection retries exhausted')).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(FakeSocket.instances).toHaveLength(5)
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Offline edits')
  view.unmount()
  vi.useRealTimers()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Offline edits')
})

it('reconnects after loss using the old client safety check even if another tab is connected and recording', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/state')
    ? Response.json({ ...initialState, client_connected: false, capture_owned: false, ui_connected: true, recording: true })
    : baseFetch(url, init))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Retain this' } })
  vi.useFakeTimers()
  act(() => backend.socket().close())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(FakeSocket.instances).toHaveLength(2)
  const stateCall = backend.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/state'))!
  expect(stateCall[1]?.headers).toEqual({ 'X-Session-ID': 'test-session' })
  act(() => backend.socket().ready())
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Retain this')
  expect(screen.getByText('Connected · local')).toBeInTheDocument()
  vi.useRealTimers()
})

it('keeps independent streams scoped while switching and ignores history reloads until a run finishes', async () => {
  await open()
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'First answer'))
  await screen.findByText('First answer')
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Second question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-2', 'Second answer'))
  await screen.findByText('Second answer')
  expect(screen.queryByText('First answer')).not.toBeInTheDocument()
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await screen.findByText('First answer')
  expect(screen.queryByText('Second answer')).not.toBeInTheDocument()
  act(() => { backend.done('chat-1'); backend.done('chat-2') })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  expect(screen.getAllByText('First answer')).toHaveLength(1)
})

it('clears the accepted draft by CAS without erasing dictation committed during the clear', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let appended = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (!appended && init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '') {
      appended = true
      const saved = backend.conversations.get('chat-1')!
      saved.draft = 'Saved words\nArrived while sending'; saved.draft_version++
    }
    return baseFetch(url, init)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Arrived while sending'))
  expect(backend.conversations.get('chat-1')?.draft).toBe('Arrived while sending')
})

it('retains edits typed while chat acceptance is pending', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let accept: (response: Response) => void = () => {}
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/chat')) return new Promise((resolve) => { accept = resolve.bind(null, response) })
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'New edits during loading' } })
  await act(async () => accept(new Response()))
  await screen.findByText('Local reply')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('New edits during loading')
})

it('refreshes the shared library on remote create/rename/delete without changing this tab’s selection', async () => {
  await open()
  backend.conversations.set('remote', { ...backend.conversations.get('chat-1')!, id: 'remote', title: 'Another tab', draft: 'Remote draft', messages: [] })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await screen.findByRole('button', { name: 'Select Another tab' })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  backend.conversations.get('remote')!.title = 'Renamed remotely'
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await screen.findByRole('button', { name: 'Select Renamed remotely' })
  backend.conversations.delete('remote')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Renamed remotely' })).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
})

it('retains unsaved draft recovery through reload after a storage failure and retries saving explicitly', async () => {
  const view = await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let storeBusy = true
  backend.fetchMock.mockImplementation(async (url, init) => init?.method === 'PATCH' && storeBusy
    ? Response.json({ detail: 'Store busy' }, { status: 503 }) : baseFetch(url, init))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Unsaved offline recovery' } })
  await screen.findByRole('button', { name: 'Retry saving draft' })
  view.unmount()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Unsaved offline recovery')
  await screen.findByRole('button', { name: 'Retry saving draft' })
  storeBusy = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving draft' }))
  await waitFor(() => expect(backend.conversations.get('chat-1')?.draft).toBe('Unsaved offline recovery'))
})

it('keeps the last local edit when typing races an in-flight save and its WS echo', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: () => void = () => {}
  let held = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (init?.method === 'PATCH' && !held) {
      held = true
      return new Promise((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'First edit' } })
  await waitFor(() => expect(held).toBe(true))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Latest edit' } })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  act(() => release())
  await waitFor(() => expect(backend.conversations.get('chat-1')?.draft).toBe('Latest edit'))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit')
  expect(screen.queryByText('Draft conflict')).not.toBeInTheDocument()
})

it('allows deliberate cancellation of the displayed conversation only', async () => {
  await open()
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  await screen.findByText('cancelled · partial reply')
  expect(screen.getByText('Partial answer')).toBeInTheDocument()
  expect(backend.requests.filter((request) => request.path === '/chat/cancel')).toHaveLength(1)
})

it('bounds stalled initial handshakes and permits an explicit fresh retry after exhaustion', async () => {
  vi.useFakeTimers()
  render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(32500) })
  expect(FakeSocket.instances).toHaveLength(5)
  expect(screen.getByText('Connection retries exhausted')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  expect(FakeSocket.instances).toHaveLength(6)
  act(() => backend.socket().ready())
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText('Connected · local')).toBeInTheDocument()
})

it('never reopens capture after loss until the old client releases it, and exhausts safety checks', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/state')
    ? Response.json({ ...initialState, client_connected: false, capture_owned: true, recording: true })
    : baseFetch(url, init))
  vi.useFakeTimers()
  act(() => backend.socket().close())
  await act(async () => { await vi.advanceTimersByTimeAsync(14000) })
  expect(screen.getByText('Recording stop is unconfirmed')).toBeInTheDocument()
  expect(screen.getByText('Connection retries exhausted')).toBeInTheDocument()
  expect(FakeSocket.instances).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
})

it('preserves a local draft when another tab deletes its selected conversation', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Recover after deletion' } })
  backend.conversations.delete('chat-1')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Recovered unsaved drafts from unavailable conversations')
  expect(screen.getByText('Recover after deletion')).toBeInTheDocument()
  expect(backend.socket().closed).toBe(false)
})

it('does not let a delayed draft-save response resurrect finished messages as streaming', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    // Hold the accepted-draft clear; its response snapshots the streaming placeholder.
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '' && release === null) {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(release).not.toBeNull())
  act(() => backend.delta('chat-1', 'Full authoritative answer'))
  await screen.findByText('Full authoritative answer')
  act(() => backend.done('chat-1'))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  await act(async () => release!())
  await waitFor(() => expect(screen.getByText('Full authoritative answer')).toBeInTheDocument())
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
})

it('retires an orphaned overlay after a failed final reload once authoritative history recovers', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let storeBusy = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (storeBusy && (init?.method ?? 'GET') !== 'PATCH' && String(url).endsWith('/conversations/chat-1')) {
      storeBusy = false
      return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    return baseFetch(url, init)
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  storeBusy = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  const saved = backend.conversations.get('chat-1')!
  saved.messages = [
    { id: 'authoritative-user', role: 'user', content: 'Saved words', status: 'complete', metrics: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'authoritative-assistant', role: 'assistant', content: 'Full authoritative answer', status: 'complete', metrics: { elapsed_seconds: 1 }, created_at: '2026-01-01T00:00:00Z' },
  ]
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
  expect(screen.queryByText('failed · partial reply')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
})

it('keeps a newly created conversation selected when an older library refresh lands late', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations')) {
      const response = await baseFetch(url, init)
      if (release === null) return new Promise<Response>((resolve) => { release = () => resolve(response) })
      return response
    }
    return baseFetch(url, init)
  })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(release).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  await act(async () => release!())
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-2' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('button', { name: 'Select First chat' })).not.toHaveAttribute('aria-current')
})

it('merges each dictated append once across repeated reloads during a delayed save', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) detailReads++
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === 'First edit') {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'First edit' } })
  await waitFor(() => expect(release).not.toBeNull())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Latest edit' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'First edit\nDictated once'; saved.draft_version++
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once'))
  const readsBeforeRepeat = detailReads
  await act(async () => {
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
    await Promise.resolve(); await Promise.resolve()
  })
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeRepeat))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once')
  // A second real append must still merge, even though the same save is pending.
  saved.draft += '\nNext dictation'; saved.draft_version++
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once\nNext dictation'))
  await act(async () => release!())
  await waitFor(() => expect(saved.draft).toBe('Latest edit\nDictated once\nNext dictation'))
})

it('keeps a failed partial reply when another conversation reloads, until its own history recovers', async () => {
  backend.conversations.set('chat-2', { ...backend.conversations.get('chat-1')!, id: 'chat-2', title: 'Second chat', draft: 'Second draft', messages: [] })
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let failFirstChat = false
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) {
      detailReads++
      if (failFirstChat) return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    return baseFetch(url, init)
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(backend.conversations.get('chat-1')!.draft).toBe(''))
  const readsBeforeCache = detailReads
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeCache))
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  failFirstChat = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Select Second chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Second draft'))
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await screen.findByText('Partial answer')
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
  const saved = backend.conversations.get('chat-1')!
  saved.messages = saved.messages.map((message) => ({ ...(message as Record<string, unknown>), status: 'complete', ...((message as Record<string, unknown>).role === 'assistant' ? { content: 'Full authoritative answer' } : {}) }))
  failFirstChat = false
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
})

it('preserves a failed partial reply when a delayed draft clear returns stale streaming history', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  let failHistory = false
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) {
      detailReads++
      if (failHistory) return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    const response = await baseFetch(url, init)
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '' && release === null) {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(release).not.toBeNull())
  const readsBeforeCache = detailReads
  await act(async () => {
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
    await Promise.resolve(); await Promise.resolve()
  })
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeCache))
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  failHistory = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  await act(async () => release!())
  expect(screen.getByText('Partial answer')).toBeInTheDocument()
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Next question' } })
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  const saved = backend.conversations.get('chat-1')!
  saved.messages = saved.messages.map((message) => ({ ...(message as Record<string, unknown>), status: 'complete', ...((message as Record<string, unknown>).role === 'assistant' ? { content: 'Full authoritative answer' } : {}) }))
  failHistory = false
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
})
