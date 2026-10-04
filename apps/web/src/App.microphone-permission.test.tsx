import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, initialState } from '@/test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
let requestAccess: ReturnType<typeof vi.fn<() => Promise<'granted' | 'denied' | 'restricted' | 'unavailable' | 'system-managed'>>>
let openSettings: ReturnType<typeof vi.fn<() => Promise<void>>>
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  backend = backendFixture()
  requestAccess = vi.fn().mockResolvedValue('granted')
  openSettings = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('outloudDesktop', { managedBackend: true, requestMicrophoneAccess: requestAccess, openMicrophoneSettings: openSettings })
})
afterEach(() => { Reflect.deleteProperty(window, 'outloudDesktop') })

async function open() {
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
}
const recordingStarts = () => backend.requests.filter((request) => request.path === '/recording/start')

it('asks on the first microphone click and waits for permission before recording', async () => {
  let grant: ((result: 'granted') => void) | undefined
  requestAccess.mockImplementation(() => new Promise((resolve) => { grant = resolve }))
  await open()
  expect(requestAccess).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await waitFor(() => expect(requestAccess).toHaveBeenCalledOnce())
  expect(recordingStarts()).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  await act(async () => grant!('granted'))
  await waitFor(() => expect(recordingStarts()).toHaveLength(1))
})

it('does not record after the connection changes while the native prompt is open', async () => {
  let grant: ((result: 'granted') => void) | undefined
  requestAccess.mockImplementation(() => new Promise((resolve) => { grant = resolve }))
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await waitFor(() => expect(requestAccess).toHaveBeenCalledOnce())
  act(() => backend.socket().close())
  await act(async () => grant!('granted'))
  expect(recordingStarts()).toHaveLength(0)
})

it('does not ask for permission to stop an existing recording', async () => {
  await open()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, recording: true, capture_owned: true, recording_id: 'r1', conversation_id: 'chat-1' } }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
  await waitFor(() => expect(backend.requests.some((request) => request.path === '/recording/stop')).toBe(true))
  expect(requestAccess).not.toHaveBeenCalled()
})

it.each(['restricted', 'unavailable'] as const)('blocks recording when native permission is %s', async (access) => {
  requestAccess.mockResolvedValue(access)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('dialog', { name: 'Recording needs attention' })
  expect(recordingStarts()).toHaveLength(0)
  expect(backend.socket().closed).toBe(false)
})

it('handles a failed native permission check without dropping the backend connection', async () => {
  requestAccess.mockRejectedValue(new Error('IPC failed'))
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const notice = await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('dialog', { name: 'Recording needs attention' })
  expect(notice).toHaveTextContent('OutLoud could not check microphone access.')
  expect(recordingStarts()).toHaveLength(0)
  expect(backend.socket().closed).toBe(false)
})

it('allows system-managed capture on platforms without a native permission API', async () => {
  requestAccess.mockResolvedValue('system-managed')
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await waitFor(() => expect(recordingStarts()).toHaveLength(1))
})

it('blocks recording after denial and offers settings without retrying automatically', async () => {
  requestAccess.mockResolvedValue('denied')
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const notice = await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('dialog', { name: 'Recording needs attention' })
  expect(notice).toHaveTextContent('Allow microphone access in your computer’s settings, then close and reopen OutLoud.')
  expect(recordingStarts()).toHaveLength(0)
  fireEvent.click(within(notice).getByRole('button', { name: 'Open microphone settings' }))
  await waitFor(() => expect(openSettings).toHaveBeenCalledOnce())
  expect(recordingStarts()).toHaveLength(0)
  requestAccess.mockResolvedValue('granted')
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await waitFor(() => expect(recordingStarts()).toHaveLength(1))
})

it('shows permission recovery again after dismissing denial and clicking the microphone again', async () => {
  requestAccess.mockResolvedValue('denied')
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: 'Recording needs attention' })
  fireEvent.mouseEnter(notifications)
  fireEvent.click(within(notice).getByRole('button', { name: 'Close toast' }))
  await waitFor(() => expect(within(notifications).queryByRole('dialog', { name: 'Recording needs attention' })).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const retryNotice = await within(notifications).findByRole('dialog', { name: 'Recording needs attention' })
  expect(within(retryNotice).getByRole('button', { name: 'Open microphone settings' })).toBeInTheDocument()
  expect(recordingStarts()).toHaveLength(0)
})

it('gives manual recovery instructions when opening microphone settings fails', async () => {
  requestAccess.mockResolvedValue('denied')
  openSettings.mockImplementation(() => { throw new Error('Could not open settings') })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  const notice = await within(notifications).findByRole('dialog', { name: 'Recording needs attention' })
  fireEvent.click(within(notice).getByRole('button', { name: 'Open microphone settings' }))
  await within(notifications).findByRole('dialog', { name: 'Couldn’t open microphone settings' })
  expect(recordingStarts()).toHaveLength(0)
})
