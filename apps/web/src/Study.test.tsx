import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, FakeSocket } from './test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); backend = backendFixture(); vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('fetch', backend.fetchMock) })
afterEach(() => vi.unstubAllGlobals())

it('creates a study subject with exam setup and unassessed syllabus coverage', async () => {
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let subjects: unknown[] = []
  backend.fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === '/study/subjects') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const subject = { ...body, id: 'subject-1', created_at: '2026-10-04', uploads: [], coverage: { total: 2, assessed: 0, demonstrated: 0 }, revision_order: ['topic-1', 'topic-2'], topics: body.topics.map((topic: {name: string}, index: number) => ({ ...topic, id: `topic-${index + 1}`, active: 1, revision: 1, weight: null, coverage: '', judgment: 'not_assessed', assessment: null, history: [], needs_reassessment: false })) }
        subjects = [subject]
        return Response.json(subject, { status: 201 })
      }
      return Response.json(subjects)
    }
    if (path.startsWith('/study/conversations/')) return Response.json(null)
    return baseFetch(url, init)
  })
  render(<App />)
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
  await act(async () => FakeSocket.instances[0]!.ready())
  fireEvent.click(screen.getByRole('button', { name: 'Study' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Subject name' }), { target: { value: 'DBMS' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Topics, one per line' }), { target: { value: 'Normalization\nTransactions' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Exam type' }), { target: { value: 'written' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create subject' }))
  expect(await screen.findByRole('heading', { name: 'DBMS' })).toBeVisible()
  expect(screen.getByText('0 of 2 topics assessed')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Study Normalization' })).toBeEnabled()
  expect(backend.requests.filter(request => request.path === '/chat')).toHaveLength(0)
})

it('keeps dictated study answers in the reviewed draft until the learner sends', async () => {
  const topic = { id: 'topic-1', name: 'Normalization', coverage: '', weight: null, active: 1, revision: 1, judgment: 'not_assessed', assessment: null, history: [], needs_reassessment: false }
  const subject = { id: 'subject-1', name: 'DBMS', exam_type: 'written', level: '', exam_date: '', topics: [topic], uploads: [], revision_order: ['topic-1'], coverage: { total: 1, assessed: 0, demonstrated: 0 } }
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname === '/study/conversations/chat-1') return Response.json({ conversation_id: 'chat-1', question: 'Explain normalization.', hinted: 0, finished: 0, topic, subject })
    return baseFetch(url, init)
  })
  render(<App />)
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
  await act(async () => FakeSocket.instances[0]!.ready())
  await screen.findByRole('region', { name: 'Study topic' })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'Saved words\nMy spoken explanation'; saved.draft_version++
  act(() => {
    backend.socket().emit({ type: 'transcription.completed', recording_id: 'study-recording', conversation_id: 'chat-1', text: 'My spoken explanation' })
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
  })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words\nMy spoken explanation'))
  expect(backend.requests.filter(request => request.path === '/chat')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.find(request => request.path === '/chat')?.body.messages).toEqual([{ role: 'user', content: 'Saved words\nMy spoken explanation' }])
})
