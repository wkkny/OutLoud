import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeartbeat } from './session-heartbeat'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('application heartbeat', () => {
  it('requires a matching pong within ten seconds', () => {
    const send = vi.fn()
    const failure = vi.fn()
    const heartbeat = createHeartbeat(send, failure)
    heartbeat.ping()
    expect(send).toHaveBeenCalledWith(1)
    heartbeat.pong(999)
    vi.advanceTimersByTime(10_000)
    expect(failure).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a healthy connection alive and rejects old pongs for a new probe', () => {
    const send = vi.fn()
    const failure = vi.fn()
    const heartbeat = createHeartbeat(send, failure)
    heartbeat.ping()
    heartbeat.pong(1)
    vi.advanceTimersByTime(15_000)
    expect(send).toHaveBeenLastCalledWith(2)
    heartbeat.pong(1)
    vi.advanceTimersByTime(9999)
    expect(failure).not.toHaveBeenCalled()
    heartbeat.pong(2)
    vi.advanceTimersByTime(5001)
    expect(send).toHaveBeenLastCalledWith(3)
    heartbeat.pong(3)
    heartbeat.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails safely when sending throws', () => {
    const failure = vi.fn()
    const heartbeat = createHeartbeat(() => { throw new Error('socket closed') }, failure)
    heartbeat.ping()
    expect(failure).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops all probes and ignores pongs after cleanup', () => {
    const send = vi.fn()
    const failure = vi.fn()
    const heartbeat = createHeartbeat(send, failure)
    heartbeat.ping()
    heartbeat.stop()
    heartbeat.pong(1)
    heartbeat.ping()
    vi.advanceTimersByTime(120_000)
    expect(send).toHaveBeenCalledOnce()
    expect(failure).not.toHaveBeenCalled()
  })
})
