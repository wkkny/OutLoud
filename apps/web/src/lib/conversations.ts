import { z } from 'zod'

import { HTTP_URL } from './backend-url'
export const messageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(),
  status: z.enum(['streaming', 'complete', 'failed', 'cancelled']),
  metrics: z.record(z.string(), z.number()).nullable(), created_at: z.string(),
})
const conversationSchema = z.object({
  id: z.string(), title: z.string(), draft: z.string(), draft_version: z.number().int().nonnegative(),
  created_at: z.string(), updated_at: z.string(),
})
const detailSchema = conversationSchema.extend({ messages: z.array(messageSchema) })
export type Conversation = z.infer<typeof conversationSchema>
export type ConversationDetail = z.infer<typeof detailSchema>
export type SavedMessage = z.infer<typeof messageSchema>
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${HTTP_URL}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(5000), ...init })
  if (!response.ok) {
    let detail = ''
    try { const body = await response.json(); detail = typeof body.detail === 'string' ? body.detail : '' } catch { /* Use HTTP status. */ }
    throw new ApiError(response.status, detail || `Backend request failed (${response.status}).`)
  }
  return response.status === 204 ? null : response.json()
}
const pathFor = (id: string) => `/conversations/${encodeURIComponent(id)}`
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const SELECTION_KEY = 'outloud.selected-conversation'
const DRAFTS_KEY = 'outloud.unsaved-drafts'
type Draft = { text: string; base: string; version: number; conflict: string | null; error: string | null }
type View = { list: Conversation[]; selectedId: string | null; details: Record<string, ConversationDetail>; historyRevisions: Record<string, number>; drafts: Record<string, Draft>; error: string | null; loading: boolean }
function stored(key: string) { try { return sessionStorage.getItem(key) } catch { return null } }

/** Durable identity comes from the backend. Only tab selection and unsaved recovery live here. */
export class ConversationLibrary {
  private view: View
  private listeners = new Set<() => void>()
  private saves = new Map<string, Promise<boolean>>()
  private savingTexts = new Map<string, { text: string; version: number }>()
  private loadSequence = new Map<string, number>()
  private refreshSequence = 0
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false
  constructor() {
    let drafts: Record<string, Draft> = {}
    try {
      const parsed = z.record(z.string(), z.object({ text: z.string(), base: z.string(), version: z.number(), conflict: z.string().nullable(), error: z.string().nullable() })).safeParse(JSON.parse(stored(DRAFTS_KEY) ?? '{}'))
      if (parsed.success) drafts = parsed.data
    } catch { /* A corrupt recovery cache must not prevent connecting. */ }
    this.view = { list: [], selectedId: stored(SELECTION_KEY), details: {}, historyRevisions: {}, drafts, error: null, loading: true }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.view
  private publish(patch: Partial<View> = {}) {
    this.view = { ...this.view, ...patch }
    if (this.disposed) return
    try {
      if (this.view.selectedId) sessionStorage.setItem(SELECTION_KEY, this.view.selectedId)
      else sessionStorage.removeItem(SELECTION_KEY)
      const unsaved = Object.fromEntries(Object.entries(this.view.drafts).filter(([, draft]) => draft.text !== draft.base || draft.conflict !== null))
      sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(unsaved))
    } catch { /* In-memory editing still works when browser storage is unavailable. */ }
    if (!this.disposed) for (const listener of this.listeners) listener()
  }
  private fail(failure: unknown) { this.publish({ error: failure instanceof Error ? failure.message : 'Local backend is unavailable.' }) }
  async refresh() {
    const sequence = ++this.refreshSequence
    try {
      const list = z.array(conversationSchema).parse(await request('/conversations'))
      if (sequence !== this.refreshSequence) return
      // A missing selected chat can be deleted remotely, but its unsaved recovery is retained.
      let selectedId = this.view.selectedId
      if (!selectedId || !list.some((item) => item.id === selectedId)) selectedId = list[0]?.id ?? null
      this.publish({ list, selectedId, error: null, loading: false })
      if (selectedId) await this.load(selectedId)
    } catch (failure) { this.fail(failure); this.publish({ loading: false }) }
  }
  async load(id: string): Promise<boolean> {
    const sequence = (this.loadSequence.get(id) ?? 0) + 1
    this.loadSequence.set(id, sequence)
    try {
      const detail = detailSchema.parse(await request(pathFor(id)))
      if (this.loadSequence.get(id) === sequence) this.accept(detail, undefined, true)
      return true
    } catch (failure) { this.fail(failure); return failure instanceof ApiError && failure.status === 404 }
  }
  private accept(detail: ConversationDetail, savedText?: string, freshHistory = false) {
    const existing = this.view.drafts[detail.id]
    // Ignore stale GETs racing a completed save/transcription reload.
    if (existing && detail.draft_version < existing.version) return
    const previous = this.view.details[detail.id]
    if (previous && detail.updated_at < previous.updated_at) {
      // A delayed save response predates the history it would replace. Its draft
      // write stays authoritative, but newer saved messages/title metadata win;
      // draft versions are not whole-conversation revisions.
      detail = { ...detail, title: previous.title, messages: previous.messages, updated_at: previous.updated_at }
      freshHistory = false
    }
    let draft: Draft = { text: detail.draft, base: detail.draft, version: detail.draft_version, conflict: null, error: null }
    if (existing) {
      const saving = this.savingTexts.get(detail.id)
      // Once a reload has acknowledged this save, existing.base already includes
      // any merged dictation. Reusing the submitted text would append it again.
      const acknowledged = saving && existing.version > saving.version
      const ownSave = saving && !acknowledged && detail.draft_version > saving.version && (saving.text === detail.draft || detail.draft.startsWith(saving.text ? `${saving.text}\n` : ''))
      const savedBase = acknowledged ? undefined : savedText ?? (ownSave ? saving.text : undefined)
      const base = savedBase ?? existing.base
      const local = existing.text
      if (local !== base && local !== detail.draft) {
        if (detail.draft === base) { draft.text = local; draft.conflict = savedBase !== undefined ? null : existing.conflict }
        else if (detail.draft.startsWith(base ? `${base}\n` : '') && detail.draft.length > base.length) {
          // Only a remote append is an unambiguous merge (including atomic dictation).
          const suffix = detail.draft.slice(base.length).replace(/^\n/, '')
          draft.text = [local, suffix].filter(Boolean).join('\n')
        } else {
          draft.text = local
          draft.conflict = detail.draft
        }
      }
    }
    this.publish({
      details: { ...this.view.details, [detail.id]: detail },
      // Only an accepted GET advances history recovery. PATCH responses can
      // contain placeholders captured before a stream's final persistence.
      ...(freshHistory ? { historyRevisions: { ...this.view.historyRevisions, [detail.id]: (this.view.historyRevisions[detail.id] ?? 0) + 1 } } : {}),
      drafts: { ...this.view.drafts, [detail.id]: draft },
      list: this.view.list.map((item) => item.id === detail.id ? detail : item),
    })
  }
  select(id: string) { this.publish({ selectedId: id }); void this.load(id) }
  async create() {
    try {
      const detail = detailSchema.parse(await request('/conversations', json('POST', {})))
      // Invalidate list requests started before this creation; their snapshots
      // cannot name this conversation and must not undo this tab's selection.
      this.refreshSequence++
      this.publish({ list: [detail, ...this.view.list], selectedId: detail.id, error: null })
      this.accept(detail)
    } catch (failure) { this.fail(failure) }
  }
  async rename(id: string, title: string) {
    if (!title.trim()) return
    try { await request(pathFor(id), json('PATCH', { title: title.trim() })); await this.refresh() } catch (failure) { this.fail(failure) }
  }
  async delete(id: string) {
    try {
      await request(pathFor(id), { method: 'DELETE' })
      clearTimeout(this.timers.get(id)); this.timers.delete(id)
      const drafts = { ...this.view.drafts }; delete drafts[id]
      const details = { ...this.view.details }; delete details[id]
      this.publish({ drafts, details, selectedId: this.view.selectedId === id ? null : this.view.selectedId })
      await this.refresh()
    } catch (failure) { this.fail(failure) }
  }
  edit(id: string, text: string) {
    const previous = this.view.drafts[id]
    if (!previous) return
    this.publish({ drafts: { ...this.view.drafts, [id]: { ...previous, text, error: null } } })
    clearTimeout(this.timers.get(id))
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.save(id) }, 350))
  }
  save(id: string): Promise<boolean> {
    const pending = this.saves.get(id)
    if (pending) return pending.then((ok) => ok ? this.save(id) : false)
    clearTimeout(this.timers.get(id)); this.timers.delete(id)
    const task = this.saveLatest(id).finally(() => { this.saves.delete(id) })
    this.saves.set(id, task)
    return task
  }
  private async saveLatest(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.disposed) return false
      const draft = this.view.drafts[id]
      if (!draft || draft.conflict !== null) return false
      if (draft.text === draft.base) return true
      try {
        this.savingTexts.set(id, { text: draft.text, version: draft.version })
        const detail = detailSchema.parse(await request(pathFor(id), json('PATCH', { draft: draft.text, draft_version: draft.version })))
        this.accept(detail, draft.text)
        this.savingTexts.delete(id)
        if (this.view.drafts[id]?.text === this.view.drafts[id]?.base) return true
      } catch (failure) {
        this.savingTexts.delete(id)
        if (failure instanceof ApiError && failure.status === 409) {
          if (!await this.load(id)) return false
          continue
        }
        const current = this.view.drafts[id]
        if (current) this.publish({ drafts: { ...this.view.drafts, [id]: { ...current, error: 'Draft not saved. Your edits are kept in this tab; retry saving.' } } })
        return false
      }
    }
    const current = this.view.drafts[id]
    if (current) this.publish({ drafts: { ...this.view.drafts, [id]: { ...current, error: 'Draft changed repeatedly elsewhere. Your edits are kept; retry saving.' } } })
    return false
  }
  resolve(id: string, text: string) {
    const draft = this.view.drafts[id]
    if (!draft) return
    this.publish({ drafts: { ...this.view.drafts, [id]: { ...draft, text, conflict: null, error: null } } })
    void this.save(id)
  }
  async clearAccepted(id: string, text: string) {
    const draft = this.view.drafts[id]
    if (!draft || draft.text !== text) return
    this.edit(id, '')
    await this.save(id)
  }
  async recover() {
    await this.refresh()
    for (const id of Object.keys(this.view.drafts)) {
      if (!this.view.list.some((item) => item.id === id)) continue
      if (this.view.drafts[id]?.text !== this.view.drafts[id]?.base) {
        await this.load(id)
        await this.save(id)
      }
    }
  }
  activate() { this.disposed = false }
  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear() }
}
