import { afterEach, expect, it, vi } from 'vitest'
import { confirmRecordingStopped } from './recording-safety'
import { initialState } from '@/test/backend-fixture'

const idle = { ...initialState, ui_connected: false }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  { ...idle, pending_commands: 1 },
  { ...idle, recording: true },
  { ...idle, ui_connected: true },
  { ...idle, workers: { ...idle.workers, recording: { status: 'failed', error: null } } },
])('does not confirm safety from an idle-looking but unsafe snapshot', async (unsafe) => {
  vi.useFakeTimers()
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(unsafe))
    .mockResolvedValueOnce(Response.json(idle))
  vi.stubGlobal('fetch', fetchMock)
  const result = confirmRecordingStopped('http://127.0.0.1:8765')
  await vi.advanceTimersByTimeAsync(250)
  expect(await result).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store')
})

it('does not treat invalid snapshots as stop confirmation', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ recording: false }))
  vi.stubGlobal('fetch', fetchMock)
  const result = confirmRecordingStopped('http://127.0.0.1:8765')
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(6)
})
