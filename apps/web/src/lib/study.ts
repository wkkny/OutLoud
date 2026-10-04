import { z } from 'zod'
import { request } from './conversations'

export const studyActionSchema = z.enum(['answer', 'explain', 'practice', 'finish'])
export type StudyAction = z.infer<typeof studyActionSchema>
export const judgmentLabels = { demonstrated: 'Demonstrated understanding', partial: 'Partial understanding', needs_revision: 'Needs revision', not_assessed: 'Not assessed' } as const
const judgment = z.enum(['demonstrated', 'partial', 'needs_revision', 'not_assessed'])
const resultSchema = z.object({ feedback: z.string(), judgment, gaps: z.array(z.string()), provisional: z.boolean(), sources: z.array(z.string()) })
const evidenceSchema = z.object({ user_message_id: z.string(), conversation_id: z.string(), answer: z.string(), question: z.string(), created_at: z.string(), revision: z.number(), hinted: z.number(), action: z.string(), result: resultSchema })
export const topicSchema = z.object({ id: z.string(), name: z.string(), coverage: z.string(), weight: z.number().nullable(), active: z.number(), revision: z.number(), judgment, assessment: resultSchema.extend({ created_at: z.string(), answer: z.string(), question: z.string(), hinted: z.boolean() }).nullable(), history: z.array(evidenceSchema), needs_reassessment: z.boolean() })
export const uploadSchema = z.object({ id: z.string(), name: z.string(), role: z.enum(['syllabus', 'reference']), text: z.string(), pages: z.array(z.number()), approved: z.boolean(), topic_ids: z.array(z.string()) })
export const subjectSchema = z.object({ id: z.string(), name: z.string(), exam_type: z.string(), level: z.string(), exam_date: z.string(), topics: z.array(topicSchema), uploads: z.array(uploadSchema), revision_order: z.array(z.string()), coverage: z.object({ total: z.number(), assessed: z.number(), demonstrated: z.number() }) })
export const sessionSchema = z.object({ conversation_id: z.string(), question: z.string(), hinted: z.number(), finished: z.number(), last_action: studyActionSchema.default('answer'), subject: subjectSchema, topic: topicSchema })
export type StudySubject = z.infer<typeof subjectSchema>
export type StudyTopic = z.infer<typeof topicSchema>
export type StudySession = z.infer<typeof sessionSchema>
export type StudyUpload = z.infer<typeof uploadSchema>
export type TopicDraft = { id?: string; name: string; coverage: string; weight: number | null }
export type SubjectDraft = { name: string; exam_type: string; level: string; exam_date: string; topics: TopicDraft[] }
export const studyPath = (id: string) => `/study/subjects/${encodeURIComponent(id)}`
export const studyJson = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export async function listSubjects() { return z.array(subjectSchema).parse(await request('/study/subjects')) }
export async function getStudySession(id: string) { return sessionSchema.nullable().parse(await request(`/study/conversations/${encodeURIComponent(id)}`)) }
