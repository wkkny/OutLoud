import { z } from 'zod'
import { studyActionSchema } from './study'

const unscopedDraftKey = 'outloud.unscoped-draft'
const pendingSendsKey = 'outloud.pending-sends'
const pendingSendSchema = z.object({
  id: z.string(), conversationId: z.string().nullable(), text: z.string(),
  createdAt: z.string(), delivery: z.enum(['sending', 'failed']), studyAction: studyActionSchema.optional(),
  mode: z.enum(['study', 'chat']).optional(), topic_ids: z.array(z.string()).optional(), focus_topic_id: z.string().nullable().optional(),
})
export type PendingSend = z.infer<typeof pendingSendSchema>
const recoveryStorage = () => window.outloudDesktop?.managedBackend ? localStorage : sessionStorage

export function readUnscopedDraft(): string {
  try { return recoveryStorage().getItem(unscopedDraftKey) ?? '' }
  catch { return '' }
}

export function writeUnscopedDraft(text: string): void {
  try {
    if (text) recoveryStorage().setItem(unscopedDraftKey, text)
    else recoveryStorage().removeItem(unscopedDraftKey)
  } catch { /* Editing still works when browser storage is unavailable. */ }
}

export function readPendingSends(): PendingSend[] {
  try {
    const parsed = z.array(pendingSendSchema).safeParse(JSON.parse(recoveryStorage().getItem(pendingSendsKey) ?? '[]'))
    // A reload cannot resume a stream. Retain its identity for an explicit retry.
    return parsed.success ? parsed.data.map((item) => ({ ...item, delivery: 'failed' })) : []
  } catch { return [] }
}

export function writePendingSends(pending: PendingSend[]): void {
  try {
    if (pending.length) recoveryStorage().setItem(pendingSendsKey, JSON.stringify(pending))
    else recoveryStorage().removeItem(pendingSendsKey)
  } catch { /* Keep in-memory retries available when browser storage is unavailable. */ }
}
