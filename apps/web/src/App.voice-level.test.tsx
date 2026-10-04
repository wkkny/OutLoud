import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, initialState } from '@/test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
beforeEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
  localStorage.clear()
  backend = backendFixture()
})
afterEach(() => { vi.useRealTimers() })

async function open() {
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
}

function recording(revision: number, recordingId: string | null, owned = true) {
  backend.socket().emit({ type: 'state.updated', state: {
    ...initialState, revision, recording: recordingId !== null, capture_owned: owned && recordingId !== null,
    recording_id: recordingId, conversation_id: recordingId ? 'chat-1' : null,
  } })
}

function level(recordingId: string, value: number) {
  backend.socket().emit({ type: 'recording.level', recording_id: recordingId, level: value })
}

it('shows actual microphone levels only during owned recording and clears them on stop', async () => {
  await open()
  expect(screen.queryByRole('meter', { name: 'Microphone level' })).not.toBeInTheDocument()
  act(() => recording(2, 'r1'))
  const meter = screen.getByRole('meter', { name: 'Microphone level' })
  expect(meter).toHaveAttribute('aria-valuenow', '0')
  expect([...meter.children].every((bar) => bar.getAttribute('style') === 'height: 3px;')).toBe(true)
  act(() => level('r1', 0.25))
  expect(meter).toHaveAttribute('aria-valuenow', '25')
  expect(meter.querySelector('[style="height: 24px;"]')).not.toBeNull()
  act(() => level('r1', 0))
  expect(meter).toHaveAttribute('aria-valuenow', '0')
  expect([...meter.children].every((bar) => bar.getAttribute('style') === 'height: 3px;')).toBe(true)
  act(() => recording(3, null))
  act(() => level('r1', 0.8))
  expect(screen.queryByRole('meter', { name: 'Microphone level' })).not.toBeInTheDocument()
  act(() => recording(4, 'r2'))
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '0')
})

it('ignores malformed, old-recording, and other-client levels', async () => {
  await open()
  act(() => recording(2, 'r1'))
  act(() => level('r1', 0.25))
  act(() => {
    level('r1', -1)
    level('r1', 2)
    level('r1', NaN)
    level('old-recording', 0.8)
  })
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '25')
  act(() => recording(3, 'r2', false))
  act(() => level('r2', 0.8))
  expect(screen.queryByRole('meter', { name: 'Microphone level' })).not.toBeInTheDocument()
  act(() => recording(4, 'r3'))
  act(() => level('r1', 0.8))
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '0')
})

it('settles stale levels to silence and hides the meter immediately on disconnect', async () => {
  await open()
  vi.useFakeTimers()
  act(() => recording(2, 'r1'))
  act(() => level('r1', 0.5))
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '50')
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '0')
  act(() => level('r1', 0.4))
  act(() => backend.socket().close())
  expect(screen.queryByRole('meter', { name: 'Microphone level' })).not.toBeInTheDocument()
})
