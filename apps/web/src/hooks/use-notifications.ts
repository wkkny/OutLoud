import { useEffect, useEffectEvent, useRef } from 'react'
import { useToastManager } from '@/components/ui/toast'
import type { ConversationLibrary } from '@/lib/conversations'
import type { Connection, Safety } from '@/lib/dictation-session'

// Only known, actionable explanations belong in a toast, not raw service errors.
const chatDescriptions: Record<string, string> = {
  'Generation capacity is busy. Wait for another conversation to finish, then try again.': "OutLoud is busy answering another chat. Your message hasn't been sent. Try again in a moment.",
  'This conversation is already generating. Wait, then try again.': 'A reply is already in progress in this chat. Wait for it to finish, then try again.',
  'The chat session expired. Reconnect before sending again.': 'Please reconnect before sending. Your text is still here.',
  'This conversation was deleted. Your unsent text is retained locally.': 'This chat was deleted. Your text is still here. Copy it into a new chat.',
  'Conversation storage is busy. Your draft is retained; try again later.': 'Your text is still here. Please try sending again in a moment.',
  'The message or conversation is too large. Shorten your text and try again.': 'This message or chat is too long. Shorten your message or start a new chat.',
  'This message is too long. Shorten it to 12,000 characters or fewer.': 'Shorten your message to 12,000 characters or fewer, then try again.',
  'The response was interrupted. Any partial reply has been kept.': 'The reply stopped early. Any text already shown is still here.',
}

function chatDescription(error: string) {
  const description = chatDescriptions[error]
  return typeof description === 'string' ? description : 'Something went wrong while getting your reply. Any text already shown is still here.'
}

function recordingDescription(error: string) {
  if (error.startsWith('Recording failed:') && error.endsWith('Check your microphone or permissions and retry.')) return "Check your microphone and allow microphone access in your computer's settings, then try again."
  if (error.startsWith('Microphone is occupied')) return 'The microphone is already in use. Stop the current recording before starting another.'
  if (error.startsWith('Transcription capacity is full.')) return 'OutLoud is busy with other recordings. Try again in a moment.'
  if (error.startsWith('This conversation was deleted.')) return 'This chat was deleted. Choose another chat before recording.'
  return 'Something went wrong with your recording. Please try again in a moment.'
}

type Notice = Parameters<ReturnType<typeof useToastManager>['add']>[0]
type NotificationsState = {
  connection: Connection
  safety: Safety
  reconnect: () => void
  selectedId: string | null
  chatError: string | null
  capacityFull: boolean | null
  draftError: string | null
  library: ConversationLibrary
  libraryError: string | null
  recordingError: string | null
}

/** Each condition owns one toast until it resolves, even if the user dismisses it. */
export function useNotifications({ connection, safety, reconnect, selectedId, chatError, capacityFull, draftError, library, libraryError, recordingError }: NotificationsState) {
  const managedBackend = window.outloudDesktop?.managedBackend === true
  const { add, close, update } = useToastManager()
  const notices = useRef(new Map<string, { id: string | null; dismissed: boolean; identity: string | null }>())
  const outage = useRef(false)
  const hide = useEffectEvent((channel: string) => {
    const notice = notices.current.get(channel)
    if (notice?.id) {
      const id = notice.id
      notice.id = null
      close(id)
    }
  })
  const sync = useEffectEvent((channel: string, options: Notice | null, identity: string | null = channel) => {
    if (!options) {
      hide(channel)
      notices.current.delete(channel)
      return
    }
    if (notices.current.get(channel)?.identity !== identity) {
      hide(channel)
      notices.current.delete(channel)
    }
    const notice = notices.current.get(channel) ?? { id: null, dismissed: false, identity }
    if (notice.dismissed) return
    if (notice.id) update(notice.id, options)
    else {
      const id = add({ ...options, onClose: () => {
        // Programmatically hiding another conversation is not user dismissal.
        if (notice.id === id) notice.dismissed = true
      } })
      notice.id = id
      notices.current.set(channel, notice)
    }
  })
  const restored = useEffectEvent(() => {
    add({ title: 'Connected again', type: 'success' })
  })

  useEffect(() => {
    const scope = selectedId
    return () => { hide(`chat:${scope}`); hide(`draft:${scope}`) }
  }, [selectedId])

  useEffect(() => {
    if (connection !== 'connected' && recordingError) { hide('recording'); return }
    sync('recording', recordingError ? {
      title: 'Recording needs attention', description: recordingDescription(recordingError), type: 'error', timeout: 0,
    } : null, recordingError)
  }, [recordingError, connection])

  useEffect(() => {
    if (connection !== 'connected' && libraryError) { hide('library'); return }
    sync('library', libraryError ? {
      title: "Couldn't update your chats", description: 'Your text is still here. Please try again in a moment.', type: 'error', timeout: 0,
    } : null, libraryError)
  }, [libraryError, connection])

  useEffect(() => {
    sync(`draft:${selectedId}`, draftError && selectedId ? {
      title: "Your changes aren't saved yet", description: 'Your text is still here. Try saving again.', type: 'error', timeout: 0,
      actionProps: { children: 'Try saving again', onClick: () => {
        // A toast can still be fading out after selection or conflict state changes.
        const current = library.getSnapshot()
        if (current.selectedId === selectedId && current.drafts[selectedId]?.conflict === null) void library.save(selectedId)
      } },
    } : null, draftError)
  }, [draftError, selectedId, library])

  useEffect(() => {
    if (capacityFull === null) { hide('capacity'); return }
    sync('capacity', capacityFull ? {
      title: 'Please wait before recording', description: 'OutLoud is busy with other recordings. You can still stop your current recording.', type: 'warning',
    } : null)
  }, [capacityFull])

  useEffect(() => {
    sync(`chat:${selectedId}`, chatError ? { title: "Couldn't get a reply", description: chatDescription(chatError), type: 'error', timeout: 0 } : null, chatError)
  }, [chatError, selectedId])

  useEffect(() => {
    if (connection === 'retrying' || connection === 'exhausted') outage.current = true
    if (connection === 'connected') {
      sync('connection', null)
      if (outage.current) restored()
      outage.current = false
    } else if (outage.current) {
      sync('connection', {
        title: connection === 'exhausted' ? "Can't connect to OutLoud" : connection === 'retrying' ? 'Trying to reconnect' : 'Connecting to OutLoud',
        description: managedBackend && connection === 'exhausted'
          ? 'Your text is still here. Try reconnecting, or close and reopen OutLoud if it remains unavailable.'
          : 'Your text is still here. Try reconnecting.',
        type: 'warning', timeout: 0,
        actionProps: { children: 'Reconnect', 'aria-label': 'Reconnect to OutLoud', disabled: safety === 'stopping', onClick: reconnect },
      })
    }
  }, [connection, safety, reconnect, managedBackend])
}
