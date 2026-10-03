import { useCallback, useEffect, useState } from 'react'
import { DictationSession, type Action, type Connection, type Safety } from '@/lib/dictation-session'
import type { PastError, Snapshot, Transcript } from '@/lib/protocol'

export { CONVERSATION_ID } from '@/lib/dictation-session'

export function useDictation() {
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pastErrors, setPastErrors] = useState<PastError[]>([])
  const [pendingCommands, setPendingCommands] = useState(0)
  const [safety, setSafety] = useState<Safety>('none')
  const [session] = useState(() => new DictationSession({
    connectionChanged: setConnection,
    snapshotChanged: setSnapshot,
    transcriptReceived: (transcript) => setTranscripts((previous) => [...previous, transcript]),
    errorChanged: setError,
    pastErrorsChanged: setPastErrors,
    pendingCommandsChanged: setPendingCommands,
    safetyChanged: setSafety,
  }))

  useEffect(() => session.start(), [attempt, session])

  const reconnect = useCallback(() => {
    const result = session.reconnect()
    if (typeof result === 'boolean') {
      if (result) setAttempt((previous) => previous + 1)
      return Promise.resolve()
    }
    return result.then((reconnected) => {
      if (reconnected) setAttempt((previous) => previous + 1)
    })
  }, [session])
  const command = useCallback((action: Action) => session.sendCommand({ action }), [session])
  const handsFree = useCallback(() => command('hands-free'), [command])
  const setFnEnabled = useCallback((enabled: boolean) => session.sendCommand({ action: 'fn', enabled }), [session])
  const acknowledgeTranscript = useCallback((recordingId: string) => session.acknowledgeTranscript(recordingId), [session])
  const dismissPastError = useCallback((id: string) => session.dismissPastError(id), [session])
  const dismissError = useCallback(() => setError(null), [])

  return {
    sessionId: session.currentSessionId,
    connection,
    snapshot,
    transcripts,
    acknowledgeTranscript,
    error,
    pastErrors,
    dismissPastError,
    pendingCommands,
    safety,
    command,
    handsFree,
    setFnEnabled,
    reconnect,
    dismissError,
  }
}
