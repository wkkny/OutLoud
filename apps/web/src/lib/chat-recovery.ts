import { z } from 'zod'

const unscopedDraftKey = 'outloud.unscoped-draft'
const pendingSendsKey = 'outloud.pending-sends'
const pendingSendSchema = z.object({
  id: z.string(), conversationId: z.string().nullable(), text: z.string(),
  createdAt: z.string(), delivery: z.enum(['sending', 'failed']),
})
export type PendingSend = z.infer<typeof pendingSendSchema>

export function readUnscopedDraft(): string {
  try { return sessionStorage.getItem(unscopedDraftKey) ?? '' }
  catch { return '' }
}

export function writeUnscopedDraft(text: string): void {
  try {
    if (text) sessionStorage.setItem(unscopedDraftKey, text)
    else sessionStorage.removeItem(unscopedDraftKey)
  } catch { /* Editing still works when browser storage is unavailable. */ }
}

export function readPendingSends(): PendingSend[] {
  try {
    const parsed = z.array(pendingSendSchema).safeParse(JSON.parse(sessionStorage.getItem(pendingSendsKey) ?? '[]'))
    // A reload cannot resume a stream. Retain its identity for an explicit retry.
    return parsed.success ? parsed.data.map((item) => ({ ...item, delivery: 'failed' })) : []
  } catch { return [] }
}

export function writePendingSends(pending: PendingSend[]): void {
  try {
    if (pending.length) sessionStorage.setItem(pendingSendsKey, JSON.stringify(pending))
    else sessionStorage.removeItem(pendingSendsKey)
  } catch { /* Keep in-memory retries available when browser storage is unavailable. */ }
}
