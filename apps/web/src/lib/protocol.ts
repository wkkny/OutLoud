import { z } from 'zod'

const jobSchema = z.object({
  recording_id: z.string(),
  conversation_id: z.string().nullable(),
})

const backendFailureSchema = z.object({
  recording_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  message: z.string(),
  occurred_at: z.iso.datetime({ offset: true }),
})

const workerSchema = z.object({
  status: z.enum(['starting', 'running', 'stopped', 'failed']),
  error: z.object({ type: z.string(), message: z.string() }).nullable(),
})

export const snapshotSchema = z.object({
  revision: z.number(),
  pending_commands: z.number().int().nonnegative(),
  capacity: z.object({
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  }),
  fn_shortcut: z.object({
    status: z.enum(['disabled', 'starting', 'enabled', 'failed']),
    error: z.string().nullable(),
  }),
  recording: z.boolean(),
  hands_free: z.boolean(),
  recording_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  ready: z.boolean(),
  shutting_down: z.boolean(),
  ui_connected: z.boolean(),
  transcription: z.object({
    status: z.enum(['idle', 'queued', 'processing', 'unavailable']),
    active_job: jobSchema.nullable(),
    queued_jobs: z.array(jobSchema),
  }),
  workers: z.object({ recording: workerSchema, transcription: workerSchema }),
  errors: z.object({
    recording: backendFailureSchema.nullable(),
    transcription: backendFailureSchema.nullable(),
  }),
})

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.pong'), id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal('transcript.acknowledged'), recording_id: z.string(), conversation_id: z.string() }),
  z.object({ type: z.literal('session.ready'), session_id: z.string(), state: snapshotSchema }),
  z.object({ type: z.literal('state.updated'), state: snapshotSchema }),
  z.object({
    type: z.literal('transcription.completed'),
    recording_id: z.string(),
    conversation_id: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.enum(['recording.error', 'recording.rejected', 'transcription.error', 'connection.error']),
    message: z.string(),
  }),
])

export type BackendFailure = z.infer<typeof backendFailureSchema>
export type PastError = {
  id: string
  kind: 'recording' | 'transcription'
  failure: BackendFailure
}
export type Snapshot = z.infer<typeof snapshotSchema>
export type Transcript = {
  recordingId: string
  text: string
}
