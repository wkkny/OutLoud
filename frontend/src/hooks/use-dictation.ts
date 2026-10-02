import { useCallback, useEffect, useRef, useState } from 'react'
import { eventSchema } from '@/lib/protocol'
import { confirmRecordingStopped } from '@/lib/recording-safety'
import type { Snapshot, Transcript } from '@/lib/protocol'

const HTTP_URL = 'http://127.0.0.1:8765'
const WS_URL = 'ws://127.0.0.1:8765/events'
export const CONVERSATION_ID = 'local-draft'

type Connection = 'connecting' | 'connected' | 'disconnected' | 'in-use'
type Action = 'press' | 'release' | 'stop' | 'hands-free'
type Safety = 'none' | 'stopping' | 'stopped' | 'unconfirmed'

export function useDictation() {
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pendingCommands, setPendingCommands] = useState(0)
  const [safety, setSafety] = useState<Safety>('none')
  const session = useRef<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const latestRevision = useRef(-1)
  const delivered = useRef(new Set<string>())
  const commands = useRef<Promise<unknown>>(Promise.resolve())
  const activeRequest = useRef<AbortController | null>(null)
  const recovering = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)

  const recover = useCallback(async (message: string) => {
    if (recovering.current) return
    recovering.current = true
    const currentGeneration = generation.current
    // Invalidate queued commands before closing. A delayed press cannot reuse this token.
    session.current = null
    activeRequest.current?.abort()
    setError(message)
    setSafety('stopping')
    setSnapshot(null)
    setConnection('disconnected')
    socketRef.current?.close()
    const stopped = await confirmRecordingStopped(HTTP_URL)
    if (mounted.current && generation.current === currentGeneration) {
      setSafety(stopped ? 'stopped' : 'unconfirmed')
    }
  }, [])

  useEffect(() => {
    let active = true
    mounted.current = true
    generation.current += 1
    session.current = null
    latestRevision.current = -1
    const socket = new WebSocket(WS_URL)
    socketRef.current = socket

    socket.onmessage = (message) => {
      if (!active || recovering.current) return
      let decoded: unknown
      try {
        decoded = JSON.parse(String(message.data))
      } catch {
        setError('The backend sent an unreadable event.')
        return
      }
      const parsed = eventSchema.safeParse(decoded)
      // Other backend events are represented by state.updated snapshots.
      if (!parsed.success) return
      const event = parsed.data
      if (event.type === 'session.ready' || event.type === 'state.updated') {
        if (event.type === 'session.ready') {
          session.current = event.session_id
          setConnection('connected')
          setError(null)
        }
        if (event.state.revision >= latestRevision.current) {
          latestRevision.current = event.state.revision
          setSnapshot(event.state)
        }
      } else if (event.type === 'transcription.completed') {
        if (event.conversation_id !== CONVERSATION_ID || delivered.current.has(event.recording_id)) return
        delivered.current.add(event.recording_id)
        setTranscripts((previous) => [...previous, { recordingId: event.recording_id, text: event.text }])
      } else {
        setError(event.message)
      }
    }

    socket.onclose = (event) => {
      if (!active) return
      const hadSession = session.current !== null
      session.current = null
      setSnapshot(null)
      setConnection(event.code === 1008 ? 'in-use' : 'disconnected')
      if (hadSession) void recover('Connection lost. The session was closed to stop recording safely.')
    }
    socket.onerror = () => {
      if (active && !recovering.current) setError('Could not connect to the local backend.')
    }
    return () => {
      active = false
      mounted.current = false
      session.current = null
      activeRequest.current?.abort()
      socket.close()
    }
  }, [attempt, recover])

  const command = useCallback((action: Action) => {
    const token = session.current
    if (!token || recovering.current) return Promise.resolve(false)
    setPendingCommands((count) => count + 1)
    const task = commands.current.then(async () => {
      if (session.current !== token || recovering.current) return false
      const controller = new AbortController()
      activeRequest.current = controller
      try {
        const response = await fetch(`${HTTP_URL}/recording/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-ID': token },
          body: action === 'press' || action === 'hands-free' ? JSON.stringify({ conversation_id: CONVERSATION_ID }) : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
        if (session.current !== token || recovering.current) return false
        if (!response.ok) {
          if (response.status === 403) throw new Error('The recording session has expired.')
          if (response.status === 503) throw new Error('Recording workers are unavailable. Check or restart the backend.')
          throw new Error(`Recording command failed (${response.status}).`)
        }
        return true
      } catch (failure) {
        if (session.current === token && !recovering.current && mounted.current) {
          await recover(failure instanceof Error ? failure.message : 'Recording command failed.')
        }
        return false
      } finally {
        activeRequest.current = null
      }
    }).finally(() => {
      if (mounted.current) setPendingCommands((count) => Math.max(0, count - 1))
    })
    commands.current = task
    return task
  }, [recover])

  const handsFree = useCallback(() => command('hands-free'), [command])

  const reconnect = async () => {
    if (safety === 'stopping') return
    if (safety === 'unconfirmed') {
      setSafety('stopping')
      const stopped = await confirmRecordingStopped(HTTP_URL)
      if (!mounted.current) return
      if (!stopped) {
        setSafety('unconfirmed')
        return
      }
    }
    recovering.current = false
    session.current = null
    setSafety('none')
    setConnection('connecting')
    setSnapshot(null)
    setError(null)
    setAttempt((previous) => previous + 1)
  }

  return {
    connection,
    snapshot,
    transcripts,
    error,
    pendingCommands,
    safety,
    command,
    handsFree,
    reconnect,
    dismissError: () => setError(null),
  }
}
