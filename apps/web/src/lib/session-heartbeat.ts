const INTERVAL_MS = 15_000
const RESPONSE_MS = 10_000

export function createHeartbeat(send: (id: number) => void, onFailure: () => void) {
  let sequence = 0
  let expected: number | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const stop = () => {
    stopped = true
    clearInterval(interval)
    if (deadline !== null) clearTimeout(deadline)
    deadline = null
    expected = null
  }
  const ping = () => {
    if (stopped || expected !== null) return
    expected = ++sequence
    deadline = setTimeout(() => { stop(); onFailure() }, RESPONSE_MS)
    try {
      send(expected)
    } catch {
      stop()
      onFailure()
    }
  }
  const interval = setInterval(ping, INTERVAL_MS)
  return {
    ping,
    stop,
    pong: (id: number) => {
      if (stopped || id !== expected) return
      if (deadline !== null) clearTimeout(deadline)
      deadline = null
      expected = null
    },
  }
}
