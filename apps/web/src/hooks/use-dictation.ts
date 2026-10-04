import { useCallback, useEffect, useState } from 'react'
import { DictationSession, type Connection, type Safety } from '@/lib/dictation-session'
import type { Snapshot } from '@/lib/protocol'
import type { ConversationLibrary } from '@/lib/conversations'

export function useDictation(library: ConversationLibrary) {
  const [connection, setConnection] = useState<Connection>('connecting')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [safety, setSafety] = useState<Safety>('none')
  const [session] = useState(() => new DictationSession({
    connectionChanged: setConnection, snapshotChanged: setSnapshot, errorChanged: setError,
    pendingCommandsChanged: setPending, safetyChanged: setSafety,
    conversationChanged: async (id) => {
      const loaded = await library.load(id)
      void library.refresh()
      return loaded
    },
    connected: () => { void library.recover() },
  }))
  useEffect(() => session.start(), [session])
  const reconnect = useCallback(() => session.reconnect(), [session])
  return { sessionId: session.currentSessionId, connection, snapshot, error, pending, safety, reconnect, command: (action: 'start' | 'stop', conversationId: string) => session.command(action, conversationId) }
}
