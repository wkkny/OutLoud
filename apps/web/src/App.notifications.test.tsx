import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, initialState } from '@/test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
beforeEach(() => { sessionStorage.clear(); backend = backendFixture() })

async function open() {
  const view = render(<StrictMode><App /></StrictMode>)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
  return view
}

function openChatAction(action: 'Rename' | 'Delete') {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select First chat' }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}

it('keeps connection retries and recovery quiet in the notification area', async () => {
  await open()
  vi.useFakeTimers()
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  fireEvent.change(composer, { target: { value: 'Keep my local words' } })
  for (const delay of [500, 1000, 2000, 4000]) {
    await act(async () => backend.socket().onerror?.())
    const notifications = screen.getByRole('region', { name: 'Notifications' })
    expect(within(notifications).queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(delay))
  }
  await act(async () => backend.socket().onerror?.())
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  act(() => backend.socket().ready())
  await act(async () => {})
  expect(within(notifications).queryByRole('dialog')).not.toBeInTheDocument()
  expect(composer).toHaveValue('Keep my local words')
})

it('keeps a refused chat request in a persistent toast without sending again automatically', async () => {
  await open()
  backend.setChatStatus(429)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: "Couldn't get a reply" })
  expect(within(notice).getByText("OutLoud is busy answering another chat. Your message hasn't been sent. Try again in a moment.")).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  vi.useFakeTimers()
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(within(notifications).getByRole('dialog', { name: "Couldn't get a reply" })).toBeInTheDocument()
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(1)
})

it('dismisses a routine capacity warning after five seconds and only warns again for a new shortage', async () => {
  await open()
  vi.useFakeTimers()
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const capacity = { limit: 3, used: 3, available: 0 }
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, capacity } }))
  expect(within(notifications).getByRole('dialog', { name: 'Please wait before recording' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(within(notifications).queryByRole('dialog', { name: 'Please wait before recording' })).not.toBeInTheDocument()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 3, capacity } }))
  expect(within(notifications).queryByRole('dialog', { name: 'Please wait before recording' })).not.toBeInTheDocument()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 4 } }))
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 5, capacity } }))
  expect(within(notifications).getByRole('dialog', { name: 'Please wait before recording' })).toBeInTheDocument()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 6 } }))
  expect(within(notifications).queryByRole('dialog', { name: 'Please wait before recording' })).not.toBeInTheDocument()
})

it('keeps unsaved words in a persistent draft toast and scopes its retry to the selected conversation', async () => {
  backend.conversations.set('chat-2', { ...backend.conversations.get('chat-1')!, id: 'chat-2', title: 'Second chat', draft: 'Other words' })
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let failing = true
  backend.fetchMock.mockImplementation(async (url, init) => init?.method === 'PATCH' && new URL(String(url)).pathname === '/conversations/chat-1' && failing
    ? Response.json({ detail: 'Store busy' }, { status: 503 }) : baseFetch(url, init))
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Keep my edited words' } })
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  await within(notifications).findByRole('dialog', { name: "Your changes aren't saved yet" })
  expect(within(notifications).getByText('Your text is still here. Try saving again.')).toBeInTheDocument()
  vi.useFakeTimers()
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(within(notifications).getByRole('dialog', { name: "Your changes aren't saved yet" })).toBeInTheDocument()
  vi.useRealTimers()
  fireEvent.click(screen.getByRole('button', { name: 'Select Second chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Other words'))
  expect(within(notifications).queryByRole('button', { name: 'Try saving again' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await within(notifications).findByRole('dialog', { name: "Your changes aren't saved yet" })
  failing = false
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notifications).getByRole('button', { name: 'Try saving again' }))
  await waitFor(() => expect(within(notifications).queryByRole('dialog', { name: "Your changes aren't saved yet" })).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Keep my edited words')
  expect(backend.conversations.get('chat-1')?.draft).toBe('Keep my edited words')
  expect(backend.conversations.get('chat-2')?.draft).toBe('Other words')
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(0)
})

it('reports a failed conversation request in a dismissible toast', async () => {
  await open()
  backend.fetchMock.mockImplementationOnce(async () => Response.json({ detail: 'sqlite3.OperationalError: database is locked (/private/outloud.db)' }, { status: 503 }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: "Couldn't update your chats" })
  expect(within(notice).getByText('Your text is still here. Please try again in a moment.')).toBeInTheDocument()
  expect(notice).not.toHaveTextContent(/sqlite|OperationalError|private|database/i)
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  await waitFor(() => expect(within(notifications).queryByRole('dialog', { name: "Couldn't update your chats" })).not.toBeInTheDocument())
})

it('reports recording failures in a toast without changing capture controls or repeating a dismissed warning', async () => {
  await open()
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  act(() => backend.socket().emit({ type: 'recording.rejected', message: 'Transcription capacity is full. Wait before recording again.' }))
  const notice = within(notifications).getByRole('dialog', { name: 'Recording needs attention' })
  expect(within(notice).getByText('OutLoud is busy with other recordings. Try again in a moment.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled()
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  act(() => backend.socket().emit({ type: 'recording.rejected', message: 'Transcription capacity is full. Wait before recording again.' }))
  expect(within(notifications).queryByRole('dialog', { name: 'Recording needs attention' })).not.toBeInTheDocument()
})

it.each([false, true])('resolves a recording refusal after a successful command and warns on a later attempt (dismissed=%s)', async (dismissed) => {
  await open()
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  backend.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 409 }))
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const notice = await within(notifications).findByRole('dialog', { name: 'Recording needs attention' })
  if (dismissed) {
    fireEvent.mouseEnter(notifications)
    fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await act(async () => {})
  expect(within(notifications).queryByRole('dialog', { name: 'Recording needs attention' })).not.toBeInTheDocument()
  backend.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 409 }))
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const next = await within(notifications).findByRole('dialog', { name: 'Recording needs attention' })
  expect(within(next).getByText('The microphone is already in use. Stop the current recording before starting another.')).toBeInTheDocument()
})

it('retains a dismissed capacity warning while capacity is unknown during reconnection', async () => {
  await open()
  vi.useFakeTimers()
  const capacity = { limit: 3, used: 3, available: 0 }
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, capacity } }))
  const notice = within(notifications).getByRole('dialog', { name: 'Please wait before recording' })
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  await act(async () => backend.socket().onerror?.())
  await act(async () => vi.advanceTimersByTimeAsync(500))
  act(() => backend.socket().ready({ capacity }))
  await act(async () => {})
  expect(within(notifications).queryByRole('dialog', { name: 'Please wait before recording' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  vi.useRealTimers()
})

it('does not respawn a dismissed storage error when the connection recovers but storage is still unavailable', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => new URL(String(url)).pathname === '/conversations'
    ? Response.json({ detail: 'Storage remains busy' }, { status: 503 }) : baseFetch(url, init))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: "Couldn't update your chats" })
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  vi.useFakeTimers()
  await act(async () => backend.socket().onerror?.())
  await act(async () => vi.advanceTimersByTimeAsync(500))
  act(() => backend.socket().ready())
  await act(async () => {})
  expect(screen.queryByText('Connected · local')).not.toBeInTheDocument()
  expect(within(notifications).queryByRole('dialog', { name: "Couldn't update your chats" })).not.toBeInTheDocument()
  vi.useRealTimers()
})

it('announces a different recording failure after the previous one was dismissed', async () => {
  await open()
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  act(() => backend.socket().emit({ type: 'recording.rejected', message: 'Microphone is occupied.' }))
  const first = within(notifications).getByRole('dialog', { name: 'Recording needs attention' })
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(first).getByRole('button', { name: 'Close toast' }))
  act(() => backend.socket().emit({ type: 'recording.rejected', message: 'This conversation was deleted.' }))
  const next = within(notifications).getByRole('dialog', { name: 'Recording needs attention' })
  expect(within(next).getByText('This chat was deleted. Choose another chat before recording.')).toBeInTheDocument()
  expect(within(notifications).getAllByRole('dialog')).toHaveLength(1)
})

it('preserves dismissal of an unresolved chat error when switching away and back', async () => {
  backend.conversations.set('chat-2', { ...backend.conversations.get('chat-1')!, id: 'chat-2', title: 'Second chat', draft: 'Other words' })
  await open()
  backend.setChatStatus(429)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: "Couldn't get a reply" })
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select Second chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Other words'))
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words'))
  expect(within(notifications).queryByRole('dialog', { name: "Couldn't get a reply" })).not.toBeInTheDocument()
})

it('confirms deletion after the confirmation dialog closes and restores focus to a surviving control', async () => {
  await open()
  openChatAction('Delete')
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  const notice = await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('dialog', { name: 'Conversation deleted' })
  expect(within(notice).getByText('First chat')).toBeInTheDocument()
  expect(screen.queryByRole('alertdialog', { name: 'Delete conversation?' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Toggle Sidebar' })).toHaveFocus())
})

it('confirms a successful rename even when the following library refresh fails', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let renamed = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname === '/conversations' && renamed) return Response.json({ detail: 'Refresh failed' }, { status: 503 })
    const response = await baseFetch(url, init)
    if (init?.method === 'PATCH') renamed = true
    return response
  })
  openChatAction('Rename')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Saved name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  expect(await within(notifications).findByRole('dialog', { name: 'Conversation renamed' })).toBeInTheDocument()
  expect(await within(notifications).findByRole('dialog', { name: "Couldn't update your chats" })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Rename conversation' })).not.toBeInTheDocument()
})

it.each(['toString', 'constructor', '__proto__', 'OllamaError: HTTP 503 at /private/model.py'])('uses a plain explanation for an unfamiliar reply error: %s', async (message) => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname !== '/chat') return baseFetch(url, init)
    const body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ type: 'chat.error', request_id: body.request_id, message }) + '\n')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  const notice = await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('dialog', { name: "Couldn't get a reply" })
  expect(within(notice).getByText('Something went wrong while getting your reply. Any text already shown is still here.')).toBeInTheDocument()
  expect(notice).not.toHaveTextContent(message)
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
})

it('explains how to fix microphone access without showing recording diagnostics', async () => {
  await open()
  act(() => backend.socket().emit({ type: 'recording.error', message: 'Recording failed: PortAudioError at /private/audio.py. Check your microphone or permissions and retry.' }))
  const notice = within(screen.getByRole('region', { name: 'Notifications' })).getByRole('dialog', { name: 'Recording needs attention' })
  expect(within(notice).getByText("Check your microphone and allow microphone access in your computer's settings, then try again.")).toBeInTheDocument()
  expect(notice).not.toHaveTextContent(/PortAudio|private|Recording failed/i)
})

it('confirms a successful rename in a dismissible notification without taking focus', async () => {
  await open()
  openChatAction('Rename')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Reviewed name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  const notifications = await screen.findByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: 'Conversation renamed' })
  expect(within(notice).getByText('Reviewed name')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select Reviewed name' })).toHaveFocus())
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  await waitFor(() => expect(within(notifications).queryByRole('dialog', { name: 'Conversation renamed' })).not.toBeInTheDocument())
})
