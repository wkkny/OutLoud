import { z } from 'zod'

const jobSchema = z.object({
  recording_id: z.string(),
  conversation_id: z.string().nullable(),
})

const workerSchema = z.object({
  status: z.enum(['starting', 'running', 'stopped', 'failed']),
  error: z.object({ type: z.string(), message: z.string() }).nullable(),
})

export const snapshotSchema = z.object({
  revision: z.number(),
  pending_commands: z.number().int().nonnegative(),
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
})

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.ready'), session_id: z.string(), state: snapshotSchema }),
  z.object({ type: z.literal('state.updated'), state: snapshotSchema }),
  z.object({
    type: z.literal('transcription.completed'),
    recording_id: z.string(),
    conversation_id: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.enum(['recording.error', 'transcription.error', 'connection.error']),
    message: z.string(),
  }),
])

export type Snapshot = z.infer<typeof snapshotSchema>
export type Transcript = {
  recordingId: string
  text: string
}
