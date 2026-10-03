import { eventSchema } from './protocol'
import { createHeartbeat } from './session-heartbeat'
import { confirmRecordingStopped } from './recording-safety'
import type { PastError, Snapshot, Transcript } from './protocol'

const HTTP_URL = 'http://127.0.0.1:8765'
const WS_URL = 'ws://127.0.0.1:8765/events'
export const CONVERSATION_ID = 'local-draft'

export type Connection = 'connecting' | 'connected' | 'disconnected' | 'in-use'
export type Action = 'press' | 'release' | 'stop' | 'hands-free'
export type BackendCommand = { action: Action } | { action: 'fn'; enabled: boolean }
export type Safety = 'none' | 'stopping' | 'stopped' | 'unconfirmed'

type SessionEvents = {
  connectionChanged: (connection: Connection) => void
  snapshotChanged: (snapshot: Snapshot | null) => void
  transcriptReceived: (transcript: Transcript) => void
  errorChanged: (error: string | null) => void
  pastErrorsChanged: (errors: PastError[]) => void
  pendingCommandsChanged: (update: (count: number) => number) => void
  safetyChanged: (safety: Safety) => void
}

/** Owns browser/backend session ordering; React consumes its observable updates. */
export class DictationSession {
  private sessionId: string | null = null
  private socket: WebSocket | null = null
  private latestRevision = -1
  private readonly delivered = new Set<string>()
  private readonly applied = new Set<string>()
  private readonly pendingAcknowledgements = new Set<string>()
  private readonly acknowledgementsInFlight = new Set<string>()
  private flushingAcknowledgements = false
  private commands: Promise<unknown> = Promise.resolve()
  private activeRequest: AbortController | null = null
  private recovering = false
  private generation = 0
  private mounted = false
  private safety: Safety = 'none'
  private readonly dismissedErrors = new Set<string>()
  private pastErrors: PastError[] = []
  private readonly events: SessionEvents

  constructor(events: SessionEvents) {
    this.events = events
  }

  get currentSessionId() {
    return this.sessionId
  }

  start(): () => void {
    let active = true
    let established = false
    let heartbeat: ReturnType<typeof createHeartbeat> | null = null
    this.mounted = true
    this.generation += 1
    this.sessionId = null
    this.latestRevision = -1
    const socket = new WebSocket(`${WS_URL}?conversation_id=${encodeURIComponent(CONVERSATION_ID)}`)
    this.socket = socket

    const connectionTimer = setTimeout(() => {
      if (!active || established) return
      active = false
      this.sessionId = null
      this.events.snapshotChanged(null)
      this.events.connectionChanged('disconnected')
      this.events.errorChanged('Connection timed out after 5 seconds. Check the backend and reconnect.')
      socket.close()
    }, 5000)

    socket.onmessage = (message) => {
      if (!active || this.recovering) return
      let decoded: unknown
      try {
        decoded = JSON.parse(String(message.data))
      } catch {
        this.events.errorChanged('The backend sent an unreadable event.')
        return
      }
      const parsed = eventSchema.safeParse(decoded)
      if (!parsed.success) return
      const event = parsed.data
      if (!established && event.type !== 'session.ready') return
      if (event.type === 'session.ready' || event.type === 'state.updated') {
        if (event.type === 'session.ready') {
          if (established) return
          established = true
          clearTimeout(connectionTimer)
          this.sessionId = event.session_id
          this.acknowledgementsInFlight.clear()
          this.events.connectionChanged('connected')
          this.events.errorChanged(null)
          heartbeat = createHeartbeat(
            (id) => socket.send(JSON.stringify({ type: 'session.ping', id })),
            () => { void this.recover('The backend stopped responding. The session was closed to stop recording safely.') },
          )
          heartbeat.ping()
          this.flushAcknowledgements()
          if (!active || this.recovering) return
          const previous: PastError[] = []
          for (const kind of ['recording', 'transcription'] as const) {
            const failure = event.state.errors[kind]
            if (failure === null) continue
            const id = JSON.stringify([kind, failure.recording_id, failure.occurred_at])
            if (!this.dismissedErrors.has(id)) previous.push({ id, kind, failure })
          }
          this.pastErrors = previous
          this.events.pastErrorsChanged(previous)
        }
        if (event.state.revision >= this.latestRevision) {
          this.latestRevision = event.state.revision
          this.events.snapshotChanged(event.state)
        }
      } else if (event.type === 'session.pong') {
        heartbeat?.pong(event.id)
      } else if (event.type === 'transcript.acknowledged') {
        if (event.conversation_id === CONVERSATION_ID) {
          this.pendingAcknowledgements.delete(event.recording_id)
          this.acknowledgementsInFlight.delete(event.recording_id)
          this.flushAcknowledgements()
        }
      } else if (event.type === 'transcription.completed') {
        if (event.conversation_id !== CONVERSATION_ID) return
        if (this.delivered.has(event.recording_id)) {
          if (this.applied.has(event.recording_id)) {
            this.pendingAcknowledgements.add(event.recording_id)
            this.acknowledgeTranscript(event.recording_id)
          }
          return
        }
        this.delivered.add(event.recording_id)
        this.events.transcriptReceived({ recordingId: event.recording_id, text: event.text })
      } else if (event.type === 'connection.error') {
        void this.recover(event.message)
      } else {
        this.events.errorChanged(event.message)
      }
    }

    socket.onclose = (event) => {
      if (!active) return
      active = false
      clearTimeout(connectionTimer)
      heartbeat?.stop()
      const hadSession = this.sessionId !== null
      this.sessionId = null
      this.events.snapshotChanged(null)
      this.events.connectionChanged(event.code === 1008 ? 'in-use' : 'disconnected')
      if (hadSession) void this.recover('Connection lost. The session was closed to stop recording safely.')
    }
    socket.onerror = () => {
      if (!active || this.recovering) return
      this.events.errorChanged('Could not connect to the local backend.')
      if (!established) {
        active = false
        clearTimeout(connectionTimer)
        this.events.connectionChanged('disconnected')
        socket.close()
      }
    }
    const resume = () => { if (active && established && !document.hidden && !this.recovering) heartbeat?.ping() }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)

    return () => {
      active = false
      clearTimeout(connectionTimer)
      heartbeat?.stop()
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
      this.mounted = false
      this.sessionId = null
      this.activeRequest?.abort()
      socket.close()
    }
  }

  private async recover(message: string) {
    if (this.recovering) return
    this.recovering = true
    const currentGeneration = this.generation
    this.sessionId = null
    this.activeRequest?.abort()
    this.events.errorChanged(message)
    this.setSafety('stopping')
    this.events.snapshotChanged(null)
    this.events.connectionChanged('disconnected')
    this.socket?.close()
    const stopped = await confirmRecordingStopped(HTTP_URL)
    if (this.mounted && this.generation === currentGeneration) this.setSafety(stopped ? 'stopped' : 'unconfirmed')
  }

  private flushAcknowledgements() {
    if (!this.sessionId || this.recovering || this.flushingAcknowledgements) return
    this.flushingAcknowledgements = true
    try {
      for (const recordingId of this.pendingAcknowledgements) {
        if (this.acknowledgementsInFlight.size >= 16) break
        if (this.acknowledgementsInFlight.has(recordingId)) continue
        this.acknowledgementsInFlight.add(recordingId)
        this.socket?.send(JSON.stringify({ type: 'transcript.ack', recording_id: recordingId, conversation_id: CONVERSATION_ID }))
      }
    } catch {
      void this.recover('Transcript acknowledgement failed. Reconnect to retry delivery safely.')
    } finally {
      this.flushingAcknowledgements = false
    }
  }

  acknowledgeTranscript(recordingId: string) {
    if (this.applied.has(recordingId) && !this.pendingAcknowledgements.has(recordingId)) return
    this.applied.add(recordingId)
    this.pendingAcknowledgements.add(recordingId)
    this.flushAcknowledgements()
  }

  dismissPastError(id: string) {
    this.dismissedErrors.add(id)
    this.pastErrors = this.pastErrors.filter((item) => item.id !== id)
    this.events.pastErrorsChanged(this.pastErrors)
  }

  sendCommand(request: BackendCommand) {
    const action = request.action
    const token = this.sessionId
    if (!token || this.recovering) return Promise.resolve(false)
    this.events.pendingCommandsChanged((count) => count + 1)
    const task = this.commands.then(async () => {
      if (this.sessionId !== token || this.recovering) return false
      const controller = new AbortController()
      this.activeRequest = controller
      try {
        const response = await fetch(`${HTTP_URL}${action === 'fn' ? '/shortcuts/fn' : `/recording/${action}`}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-ID': token },
          body: request.action === 'fn'
            ? JSON.stringify({ enabled: request.enabled, conversation_id: CONVERSATION_ID })
            : action === 'press' || action === 'hands-free' ? JSON.stringify({ conversation_id: CONVERSATION_ID }) : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
        if (this.sessionId !== token || this.recovering) return false
        if (!response.ok) {
          if (response.status === 429 && (action === 'press' || action === 'hands-free')) {
            this.events.errorChanged('Transcription capacity is full. Wait for a job to finish before recording again.')
            return false
          }
          if (response.status === 403) throw new Error('The recording session has expired.')
          if (response.status === 503) throw new Error('Recording workers are unavailable. Check or restart the backend.')
          throw new Error(`Recording command failed (${response.status}).`)
        }
        return true
      } catch (failure) {
        if (this.sessionId === token && !this.recovering && this.mounted) {
          await this.recover(failure instanceof Error ? failure.message : 'Recording command failed.')
        }
        return false
      } finally {
        this.activeRequest = null
      }
    }).finally(() => {
      if (this.mounted) this.events.pendingCommandsChanged((count) => Math.max(0, count - 1))
    })
    this.commands = task
    return task
  }

  reconnect(): boolean | Promise<boolean> {
    if (this.safety === 'stopping') return false
    if (this.safety === 'unconfirmed') {
      this.setSafety('stopping')
      return confirmRecordingStopped(HTTP_URL).then((stopped) => {
        if (!this.mounted) return false
        if (!stopped) {
          this.setSafety('unconfirmed')
          return false
        }
        return this.prepareReconnect()
      })
    }
    return this.prepareReconnect()
  }

  private prepareReconnect() {
    this.recovering = false
    this.sessionId = null
    this.setSafety('none')
    this.events.connectionChanged('connecting')
    this.events.snapshotChanged(null)
    this.events.errorChanged(null)
    return true
  }

  private setSafety(safety: Safety) {
    this.safety = safety
    this.events.safetyChanged(safety)
  }
}
