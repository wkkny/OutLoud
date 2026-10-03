import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { backendFixture } from '@/test/backend-fixture'
import App from './App'

vi.hoisted(() => { vi.stubEnv('VITE_BACKEND_URL', 'http://127.0.0.1:8876/') })

it('uses the configured backend for library, recording, chat and the derived unscoped WebSocket', async () => {
  sessionStorage.clear()
  const backend = backendFixture()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
  expect(backend.socket().url).toBe('ws://127.0.0.1:8876/events')
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
  await waitFor(() => expect(backend.requests.some((request) => request.path === '/recording/start')).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.fetchMock.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:8876/'))).toBe(true)
})
