import { useEffect, useState, useSyncExternalStore } from 'react'
import { ConversationLibrary } from '@/lib/conversations'

export function useConversations() {
  const [library] = useState(() => new ConversationLibrary())
  const view = useSyncExternalStore(library.subscribe, library.getSnapshot)
  useEffect(() => {
    library.activate()
    void library.refresh()
    return () => library.dispose()
  }, [library])
  return { ...view, library }
}
