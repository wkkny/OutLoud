import type { Snapshot } from '@/lib/protocol'

export const initialState: Snapshot = {
  revision: 1,
  pending_commands: 0,
  capacity: { limit: 3, used: 0, available: 3 },
  fn_shortcut: { status: 'disabled', error: null },
  recording: false,
  hands_free: false,
  recording_id: null,
  conversation_id: null,
  ready: true,
  errors: { recording: null, transcription: null },
  shutting_down: false,
  ui_connected: true,
  transcription: { status: 'idle', active_job: null, queued_jobs: [] },
  workers: {
    recording: { status: 'running', error: null },
    transcription: { status: 'running', error: null },
  },
}
