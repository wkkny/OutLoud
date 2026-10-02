import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '@/test/backend-fixture'
import { useDictation } from './use-dictation'

class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  autoPong = true
  sent: string[] = []
  send(data: string) {
    if (this.closed) throw new Error('Socket closed')
    this.sent.push(data)
    const message = JSON.parse(data)
    if (message.type === 'session.ping' && this.autoPong) this.emit({ type: 'session.pong', id: message.id })
  }

  constructor() { FakeSocket.instances.push(this) }
  close() { this.closed = true; this.onclose?.({ code: 1000 }) }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
  ready(token = 'session') { this.emit({ type: 'session.ready', session_id: token, state: initialState }) }
}

function socket() { return FakeSocket.instances[FakeSocket.instances.length - 1] }

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...initialState, ui_connected: false })))
})
afterEach(() => vi.useRealTimers())

describe('connection lifecycle', () => {
  it('times out a socket that never opens after five seconds', async () => {
    const { result } = renderHook(useDictation)
    await act(async () => { await vi.advanceTimersByTimeAsync(4999) })
    expect(result.current.connection).toBe('connecting')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current.connection).toBe('disconnected')
    expect(result.current.error).toContain('Connection timed out after 5 seconds')
    expect(socket().closed).toBe(true)
    expect(result.current.snapshot).toBeNull()
  })

  it('does not treat an open socket or a snapshot as an established session', async () => {
    const { result } = renderHook(useDictation)
    act(() => {
      socket().onopen?.()
      socket().emit({ type: 'state.updated', state: initialState })
    })
    expect(result.current.connection).toBe('connecting')
    expect(result.current.snapshot).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.current.connection).toBe('disconnected')
  })

  it('requires a valid session.ready before canceling the timeout', async () => {
    const { result } = renderHook(useDictation)
    act(() => socket().emit({ type: 'session.ready', session_id: 'session', state: {} }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.current.connection).toBe('disconnected')
    expect(result.current.error).toContain('Connection timed out')
  })

  it('cancels the timeout when a valid session arrives in time', async () => {
    const { result } = renderHook(useDictation)
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    act(() => socket().ready())
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(result.current.connection).toBe('connected')
    expect(result.current.error).toBeNull()
    expect(socket().closed).toBe(false)
  })

  it('ignores expired-attempt events before and after a successful retry', async () => {
    const { result } = renderHook(useDictation)
    const expired = socket()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    act(() => expired.ready('expired-token'))
    expect(result.current.connection).toBe('disconnected')
    await act(async () => { await result.current.reconnect() })
    expect(FakeSocket.instances).toHaveLength(2)
    act(() => expired.ready('expired-token'))
    expect(result.current.connection).toBe('connecting')
    act(() => socket().ready('new-token'))
    act(() => expired.emit({ type: 'recording.error', message: 'Stale error' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.current.connection).toBe('connected')
    expect(result.current.error).toBeNull()
  })

  it('cancels the timer on an early close and ignores later events from that socket', async () => {
    const { result } = renderHook(useDictation)
    act(() => socket().close())
    act(() => socket().ready())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.current.connection).toBe('disconnected')
    expect(result.current.error).toBeNull()
  })

  it('allows retry immediately after a handshake error', async () => {
    const { result } = renderHook(useDictation)
    act(() => socket().onerror?.())
    expect(result.current.connection).toBe('disconnected')
    expect(socket().closed).toBe(true)
    expect(result.current.error).toBe('Could not connect to the local backend.')
    await act(async () => { await result.current.reconnect() })
    act(() => socket().ready())
    expect(result.current.connection).toBe('connected')
  })

  it('closes an established but unresponsive socket and confirms recording stopped', async () => {
    const { result } = renderHook(useDictation)
    socket().autoPong = false
    act(() => socket().ready())
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(socket().closed).toBe(true)
    expect(result.current.connection).toBe('disconnected')
    expect(result.current.safety).toBe('stopped')
    expect(result.current.error).toContain('backend stopped responding')
    expect(result.current.snapshot).toBeNull()
  })

  it('probes immediately when the page becomes visible and cleans up established heartbeat timers', () => {
    const { unmount } = renderHook(useDictation)
    act(() => socket().ready())
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(socket().sent.map((data) => JSON.parse(data).id)).toEqual([1, 2])
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the connection timer on unmount', () => {
    const { unmount } = renderHook(useDictation)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket().closed).toBe(true)
  })
})
