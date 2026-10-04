import { eventSchema } from './protocol'
import { createHeartbeat } from './session-heartbeat'
import { confirmRecordingStopped } from './recording-safety'
import { HTTP_URL, WS_URL } from './backend-url'
import type { Snapshot } from './protocol'

export type Connection = 'connecting' | 'connected' | 'retrying' | 'exhausted'
export type Safety = 'none' | 'stopping' | 'stopped' | 'unconfirmed'
type SessionEvents = {
  connectionChanged: (connection: Connection) => void
  snapshotChanged: (snapshot: Snapshot | null) => void
  levelChanged: (level: number) => void
  conversationChanged: (id: string) => Promise<boolean>
  connected: () => void
  errorChanged: (error: string | null) => void
  pendingCommandsChanged: (pending: boolean) => void
  recordingAttempted: () => void
  safetyChanged: (safety: Safety) => void
}
const BACKOFF = [500, 1000, 2000, 4000]

/** One unscoped connection per tab; selecting a conversation never replaces it. */
export class DictationSession {
  private sessionId: string | null = null
  private oldSessionId: string | null = null
  private socket: WebSocket | null = null
  private heartbeat: ReturnType<typeof createHeartbeat> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private mounted = false
  private epoch = 0
  private failures = 0
  private latestRevision = -1
  private recordingId: string | null = null
  private levelTimer: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private acknowledgements = new Map<string, string>()
  private acknowledgementsInFlight = new Set<string>()
  private flushingAcknowledgements = false
  private reloading = new Set<string>()
  private events: SessionEvents
  constructor(events: SessionEvents) { this.events = events }
  get currentSessionId() { return this.sessionId }
  start() {
    this.mounted = true
    this.failures = 0
    void this.connect()
    const resume = () => { if (!document.hidden) this.heartbeat?.ping() }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)
    return () => {
      this.mounted = false; this.epoch++
      if (this.timer) clearTimeout(this.timer)
      this.heartbeat?.stop()
      this.socket?.close(); this.sessionId = null
      this.clearLevel()
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
    }
  }
  private async connect() {
    if (!this.mounted) return
    const epoch = ++this.epoch
    this.events.connectionChanged(this.failures ? 'retrying' : 'connecting')
    if (this.oldSessionId) {
      this.events.safetyChanged('stopping')
      const stopped = await confirmRecordingStopped(HTTP_URL, this.oldSessionId)
      if (!this.mounted || epoch !== this.epoch) return
      this.events.safetyChanged(stopped ? 'stopped' : 'unconfirmed')
      if (!stopped) { this.scheduleRetry(); return }
      this.oldSessionId = null
    }
    this.events.safetyChanged('none')
    let socket: WebSocket
    try { socket = new WebSocket(WS_URL) } catch { this.scheduleRetry(); return }
    this.socket = socket
    this.latestRevision = -1
    this.timer = setTimeout(() => { if (epoch === this.epoch) void this.lost('Connection timed out.') }, 5000)
    socket.onmessage = (message) => {
      if (!this.mounted || epoch !== this.epoch) return
      let decoded: unknown
      try { decoded = JSON.parse(String(message.data)) } catch { return }
      const parsed = eventSchema.safeParse(decoded)
      if (!parsed.success) return
      const event = parsed.data
      if (!this.sessionId && event.type !== 'session.ready') return
      if (event.type === 'session.ready') {
        if (this.sessionId) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.sessionId = event.session_id
        this.acknowledgementsInFlight.clear()
        this.failures = 0
        this.events.errorChanged(null)
        this.events.connectionChanged('connected')
        this.applySnapshot(event.state)
        this.heartbeat = createHeartbeat((id) => socket.send(JSON.stringify({ type: 'session.ping', id })), () => { void this.lost('The backend stopped responding.') })
        this.heartbeat.ping()
        this.events.connected()
        this.flushAcknowledgements()
      } else if (event.type === 'state.updated') this.applySnapshot(event.state)
      else if (event.type === 'recording.level' && event.recording_id === this.recordingId) {
        if (this.levelTimer) clearTimeout(this.levelTimer)
        this.events.levelChanged(event.level)
        this.levelTimer = setTimeout(() => { this.levelTimer = null; this.events.levelChanged(0) }, 400)
      } else if (event.type === 'session.pong') this.heartbeat?.pong(event.id)
      else if (event.type === 'conversation.updated') void this.events.conversationChanged(event.conversation_id)
      else if (event.type === 'transcription.completed' && event.conversation_id) {
        const id = event.conversation_id
        const key = JSON.stringify([event.recording_id, id])
        if (this.reloading.has(key)) return
        this.reloading.add(key)
        // Backend has already persisted the transcript exactly once. Re-read, never append.
        void this.events.conversationChanged(id).then((loaded) => {
          if (loaded) { this.acknowledgements.set(event.recording_id, id); this.flushAcknowledgements() }
        }).finally(() => this.reloading.delete(key))
      } else if (event.type === 'transcript.acknowledged') {
        if (this.acknowledgements.get(event.recording_id) === event.conversation_id) {
          this.acknowledgements.delete(event.recording_id)
          this.acknowledgementsInFlight.delete(event.recording_id)
          this.flushAcknowledgements()
        }
      } else if (event.type === 'connection.error') void this.lost(event.message)
      else if ('message' in event) this.events.errorChanged(event.message)
    }
    socket.onclose = () => { if (epoch === this.epoch) void this.lost('Connection lost. Local edits are retained.') }
    socket.onerror = () => { if (epoch === this.epoch) void this.lost('Could not connect to the local backend.') }
  }
  private clearLevel() {
    if (this.levelTimer) clearTimeout(this.levelTimer)
    this.levelTimer = null
    this.recordingId = null
    this.events.levelChanged(0)
  }
  private applySnapshot(snapshot: Snapshot) {
    if (snapshot.revision >= this.latestRevision) {
      const recordingId = snapshot.recording && snapshot.capture_owned ? snapshot.recording_id : null
      if (recordingId !== this.recordingId) {
        this.clearLevel()
        this.recordingId = recordingId
      }
      this.latestRevision = snapshot.revision; this.events.snapshotChanged(snapshot)
    }
  }
  private async lost(message: string) {
    if (!this.mounted) return
    this.epoch++ // invalidate socket callbacks before closing
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.heartbeat?.stop(); this.heartbeat = null
    this.oldSessionId = this.sessionId ?? this.oldSessionId
    this.sessionId = null
    this.clearLevel()
    this.events.snapshotChanged(null)
    this.events.errorChanged(message)
    this.socket?.close()
    this.scheduleRetry()
  }
  private scheduleRetry() {
    if (!this.mounted) return
    const delay = BACKOFF[this.failures++]
    if (delay === undefined) {
      this.events.connectionChanged('exhausted')
      this.events.errorChanged('Automatic connection retries exhausted. Your selected conversation and local edits are retained. Reconnect to try again.')
      return
    }
    this.events.connectionChanged('retrying')
    this.timer = setTimeout(() => { this.timer = null; void this.connect() }, delay)
  }
  reconnect() {
    if (this.timer) clearTimeout(this.timer)
    this.epoch++; this.heartbeat?.stop(); this.socket?.close()
    this.oldSessionId = this.sessionId ?? this.oldSessionId; this.sessionId = null
    this.clearLevel()
    this.events.snapshotChanged(null)
    this.failures = 0
    void this.connect()
  }
  private flushAcknowledgements() {
    if (!this.sessionId || this.flushingAcknowledgements) return
    this.flushingAcknowledgements = true
    try {
      for (const [recordingId, conversationId] of this.acknowledgements) {
        if (this.acknowledgementsInFlight.size >= 16) break
        if (this.acknowledgementsInFlight.has(recordingId)) continue
        this.acknowledgementsInFlight.add(recordingId)
        this.socket?.send(JSON.stringify({ type: 'transcript.ack', recording_id: recordingId, conversation_id: conversationId }))
      }
    } catch { void this.lost('Transcript acknowledgement failed; reconnecting to retry.') }
    finally { this.flushingAcknowledgements = false }
  }
  async command(action: 'start' | 'stop', conversationId: string) {
    const token = this.sessionId
    if (!token || this.pending) return false
    this.pending = true; this.events.pendingCommandsChanged(true)
    if (action === 'start') {
      this.events.recordingAttempted()
      this.events.errorChanged(null)
    }
    try {
      if (action === 'start' && window.outloudDesktop?.managedBackend) {
        let access: Awaited<ReturnType<typeof window.outloudDesktop.requestMicrophoneAccess>>
        try { access = await window.outloudDesktop.requestMicrophoneAccess() }
        catch {
          if (this.mounted && this.sessionId === token) this.events.errorChanged('Could not check microphone permission.')
          return false
        }
        if (!this.mounted || this.sessionId !== token) return false
        if (access !== 'granted' && access !== 'system-managed') {
          this.events.errorChanged(access === 'denied' ? 'Microphone permission denied.' : access === 'restricted' ? 'Microphone permission restricted.' : 'Could not check microphone permission.')
          return false
        }
      }
      const response = await fetch(`${HTTP_URL}/recording/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-ID': token },
        body: action === 'start' ? JSON.stringify({ conversation_id: conversationId }) : undefined,
        signal: AbortSignal.timeout(5000),
      })
      if (this.sessionId !== token) return false
      if (response.status === 409) { this.events.errorChanged('Microphone is occupied or a recording is already active.'); return false }
      if (response.status === 429) { this.events.errorChanged('Transcription capacity is full. Wait before recording again.'); return false }
      if (response.status === 404) { this.events.errorChanged('This conversation was deleted. Select another conversation.'); return false }
      if (!response.ok) throw new Error(`Recording command failed (${response.status}).`)
      this.events.errorChanged(null)
      return true
    } catch (failure) {
      if (this.sessionId === token) await this.lost(failure instanceof Error ? failure.message : 'Recording command failed.')
      return false
    } finally {
      this.pending = false
      if (this.mounted) this.events.pendingCommandsChanged(false)
    }
  }
}
