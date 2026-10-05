import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { backendFixture, FakeSocket, initialState, makeSubject } from '@/test/backend-fixture'

let backend: ReturnType<typeof backendFixture>
beforeEach(() => { vi.useRealTimers(); sessionStorage.clear(); localStorage.clear(); Reflect.deleteProperty(window, 'outloudDesktop'); backend = backendFixture() })
afterEach(() => { Reflect.deleteProperty(window, 'outloudDesktop') })
function openChatAction(action: 'Rename' | 'Delete', chat = 'First chat') {
  fireEvent.contextMenu(screen.getByRole('button', { name: `Select ${chat}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}
it('keeps the conversation name in the sidebar without a workspace breadcrumb', async () => {
  backend.conversations.clear()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  expect(screen.queryByRole('navigation', { name: 'Workspace breadcrumb' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select New conversation' })).toBeVisible())
  expect(screen.queryByRole('navigation', { name: 'Workspace breadcrumb' })).not.toBeInTheDocument()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select New conversation' }))
  expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeEnabled()
})

it('keeps sidebar navigation without storage explanations or a pretend workspace footer', async () => {
  await open()
  expect(screen.queryByText('Conversations are saved on this Mac and shared across tabs. This tab remembers its selected chat.')).not.toBeInTheDocument()
  expect(screen.queryByText('Local workspace')).not.toBeInTheDocument()
  expect(screen.queryByText('Private on this Mac')).not.toBeInTheDocument()
  expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Select First chat' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled()
})

it('keeps routine composer copy quiet but shows unsaved changes until the save completes', async () => {
  await open()
  expect(screen.queryByText('Your draft is saved locally')).not.toBeInTheDocument()
  expect(screen.queryByText('Audio and conversations stay on this Mac')).not.toBeInTheDocument()
  expect(screen.queryByText('Whisper transcription · Gemma chat runs locally')).not.toBeInTheDocument()
  const modelLabels = screen.getAllByText('Gemma 3:4b')
  expect(modelLabels).toHaveLength(1)
  modelLabels.forEach(model => expect(model).toBeVisible())
  expect(screen.queryByText('· local')).not.toBeInTheDocument()
  expect(screen.queryByText('⌘ / Ctrl')).not.toBeInTheDocument()
  expect(screen.getByText('Enter')).toBeVisible()
  expect(screen.getByText('to send · Shift+Enter for a new line')).toBeVisible()
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(composer).not.toHaveAccessibleDescription()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | undefined
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/conversations/chat-1') && init?.method === 'PATCH') return new Promise((resolve) => { release = () => resolve(response) })
    return response
  })
  fireEvent.change(composer, { target: { value: 'My reviewed words' } })
  expect(screen.getByText('Unsaved changes kept in this tab')).toBeVisible()
  expect(composer).toHaveAccessibleDescription('Unsaved changes kept in this tab')
  await waitFor(() => expect(release).toBeDefined())
  await act(async () => release!())
  await waitFor(() => expect(screen.queryByText('Unsaved changes kept in this tab')).not.toBeInTheDocument())
  expect(composer).toHaveValue('My reviewed words')
  expect(composer).not.toHaveAccessibleDescription()
  expect(screen.queryByText('Your draft is saved locally')).not.toBeInTheDocument()
})

it('puts a suggested prompt in the draft for review without sending or replacing existing words', async () => {
  await open()
  expect(screen.getByRole('button', { name: 'Make a plan' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  await waitFor(() => expect(composer).toHaveValue(''))
  fireEvent.click(screen.getByRole('button', { name: 'Make a plan' }))
  expect(composer).toHaveValue('Help me turn my ideas into a practical plan.')
  expect(composer).toHaveFocus()
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Brainstorm ideas' })).toBeDisabled()
})

it('sends with Enter while preserving Shift+Enter and IME composition', async () => {
  await open()
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })).toBe(true)
  expect(fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })).toBe(true)
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(0)
  expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false)
  await screen.findByText('Local reply')
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(1)
})

it('renders assistant markdown while keeping user text literal and model HTML and images inert', async () => {
  const saved = backend.conversations.get('chat-1')!
  saved.messages = [
    { id: 'user-markdown', role: 'user', content: '**My words**', status: 'complete', metrics: null, created_at: saved.created_at },
    { id: 'assistant-markdown', role: 'assistant', content: '## A plan\n\n**First step**\n\n- Review\n- Send\n\n```js\nconst value = 1\n```\n\n| Task | State |\n| --- | --- |\n| Review | Ready |\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/tracker.png)\n\n[unsafe](javascript:alert%281%29)', status: 'complete', metrics: null, created_at: saved.created_at },
  ]
  const view = await open()
  expect(screen.getByText('**My words**')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'A plan' })).toBeInTheDocument()
  expect(screen.getByText('First step').tagName).toBe('STRONG')
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByText('const value = 1')).toBeInTheDocument()
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.querySelector('img')).toBeNull()
  expect(screen.getByText('unsafe').getAttribute('href')).not.toMatch(/^javascript:/)
})

async function open() {
  const view = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select First chat' })
  return view
}

it('lets the user compose before a conversation exists and creates one when sending', async () => {
  backend.conversations.clear()
  render(<App />)
  act(() => backend.socket().ready())
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(composer).toBeEnabled()
  expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await screen.findByText('Your conversations will appear here.')
  expect(screen.queryByText('Your first message starts a new chat. Conversations are saved locally.')).not.toBeInTheDocument()
  expect(screen.queryByText('A new chat starts when you send')).not.toBeInTheDocument()
  expect(backend.requests.filter((request) => request.path === '/conversations' && request.method === 'POST')).toHaveLength(0)
  fireEvent.change(composer, { target: { value: 'Start a conversation' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.filter((request) => request.path === '/conversations' && request.method === 'POST')).toHaveLength(1)
  expect(backend.requests.find((request) => request.path === '/chat')?.body).toMatchObject({
    conversation_id: expect.any(String),
    messages: [{ role: 'user', content: 'Start a conversation' }],
  })
})

it('uses subject-backed topics and a saved sidebar mode switch without a side card', async () => {
  const subject = makeSubject()
  backend.subjects.push(subject)
  const conversation = backend.conversations.get('chat-1')!
  Object.assign(conversation, { subject_id: subject.id, topic_ids: [subject.topics[0]!.id], focus_topic_id: subject.topics[0]!.id })
  const view = render(<App />)
  act(() => backend.socket().ready())
  fireEvent.click(await screen.findByRole('button', { name: 'Select First chat' }))
  expect(screen.queryByRole('complementary', { name: 'Materials' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Select First chat' })).toHaveTextContent('Database Systems')
  expect(screen.getByRole('button', { name: /^Chat$/ })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', { name: /^Study$/ }))
  await waitFor(() => expect(backend.requests.some(request => request.path === '/conversations/chat-1' && request.method === 'PATCH' && request.body.mode === 'study')).toBe(true))
  expect(screen.getByRole('button', { name: /^Study$/ })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', { name: /^Chat$/ }))
  await waitFor(() => expect(backend.requests.some(request => request.path === '/conversations/chat-1' && request.method === 'PATCH' && request.body.mode === 'chat')).toBe(true))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Help me understand this topic.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.find(request => request.path === '/chat')?.body).toMatchObject({ mode: 'chat', topic_ids: [subject.topics[0]!.id], focus_topic_id: subject.topics[0]!.id })
  expect(screen.queryByRole('button', { name: 'Mark reply as study guidance for Normalization' })).not.toBeInTheDocument()
  expect(await screen.findByText('Counts as Study guidance for Normalization')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Exclude as guidance' }))
  expect(await screen.findByText('Not counted as Study guidance')).toBeVisible()
  view.unmount()
  render(<App />)
  act(() => backend.socket().ready())
  fireEvent.click(await screen.findByRole('button', { name: 'Select First chat' }))
  expect(await screen.findByText('Not counted as Study guidance')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Count as guidance' }))
  await waitFor(() => expect(backend.requests.some(request => request.path === `/study/conversations/chat-1/guidance` && request.method === 'POST')).toBe(true))
})

it('lets the learner save a requested tutor reply as the active Study question', async () => {
  const subject = makeSubject()
  backend.subjects.push(subject)
  const conversation = backend.conversations.get('chat-1')!
  const topic = subject.topics[0]!
  Object.assign(conversation, { subject_id: subject.id, mode: 'study', topic_ids: [topic.id], focus_topic_id: topic.id })
  conversation.messages = [
    { id: 'question-user', role: 'user', content: 'Give me a question.', status: 'complete', metrics: null, created_at: '2026-01-01T00:00:00Z', turn_context: { mode: 'study', topic_ids: [topic.id], focus_topic_id: topic.id, question: '', action: 'chat', assisted: false } },
    { id: 'question-assistant', role: 'assistant', content: 'Explain normalization.', status: 'complete', metrics: null, created_at: '2026-01-01T00:00:01Z' },
  ]
  render(<App />)
  act(() => backend.socket().ready())
  expect(await screen.findByRole('button', { name: 'Select First chat' })).toHaveTextContent(subject.name)
  fireEvent.click(await screen.findByRole('button', { name: 'Select First chat' }))
  await screen.findByText('Explain normalization.')
  fireEvent.click(await screen.findByRole('button', { name: 'Use reply as Study question' }))
  const question = screen.getByRole('textbox', { name: 'Save this reply as the active Study question' })
  expect(question).toHaveValue('Explain normalization.')
  fireEvent.change(question, { target: { value: 'Explain first, second, and third normal forms.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save question' }))
  await waitFor(() => expect(backend.requests.some(request => request.path === '/study/conversations/chat-1/question' && request.method === 'POST' && request.body.question === 'Explain first, second, and third normal forms.')).toBe(true))
})

it('filters conversations by subject without changing their history', async () => {
  backend.subjects.push(makeSubject(), makeSubject('subject-2', 'Biology'))
  Object.assign(backend.conversations.get('chat-1')!, { subject_id: 'subject-1' })
  render(<App />)
  act(() => backend.socket().ready())
  fireEvent.click(await screen.findByRole('button', { name: 'Select First chat' }))
  expect(screen.queryByRole('combobox', { name: 'Move First chat to subject' })).not.toBeInTheDocument()
  const user = userEvent.setup()
  const filter = screen.getByRole('combobox', { name: 'Filter conversations by subject' })
  await user.click(filter)
  await user.click(await screen.findByRole('option', { name: 'Biology' }))
  expect(filter).toHaveTextContent('Biology')
  expect(screen.queryByRole('button', { name: 'Select First chat' })).not.toBeInTheDocument()
  expect(backend.conversations.get('chat-1')?.messages).toEqual([])
})

it('recovers the first-chat draft and its unsaved warning after a reload', async () => {
  backend.conversations.clear()
  const view = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Keep these first-chat words' } })
  view.unmount()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(composer).toHaveValue('Keep these first-chat words')
  expect(composer).toHaveAccessibleDescription('Unsaved changes kept in this tab')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  await waitFor(() => expect(composer).toHaveValue(''))
  expect(within(screen.getByRole('article', { name: 'You' })).getByText('Keep these first-chat words')).toBeVisible()
})

it('keeps recovered first-chat edits when an earlier creation finishes after unmount', async () => {
  backend.conversations.clear()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | undefined
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/conversations') && init?.method === 'POST') {
      return new Promise((resolve) => { release = () => { void baseFetch(url, init).then(resolve) } })
    }
    return baseFetch(url, init)
  })
  const view = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Original first-chat words' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(release).toBeDefined())
  view.unmount()
  const recovered = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Newer recovered words' } })
  await act(async () => release!())
  recovered.unmount()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByRole('button', { name: 'Select New conversation' })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Newer recovered words')
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(0)
  await screen.findByText('Not sent')
  expect(within(screen.getByRole('article', { name: 'You' })).getByText('Original first-chat words')).toBeVisible()
  const retry = screen.getByRole('button', { name: 'Retry' })
  await waitFor(() => expect(retry).toBeEnabled())
  fireEvent.click(retry)
  await screen.findByText('Local reply')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Newer recovered words')
  expect(backend.requests.filter((request) => request.path === '/conversations' && request.method === 'POST')).toHaveLength(1)
  expect(backend.requests.find((request) => request.path === '/chat')?.body.messages).toEqual([{ role: 'user', content: 'Original first-chat words' }])
})

it('shows the first message immediately while its conversation is still being created', async () => {
  backend.conversations.clear()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | undefined
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/conversations') && init?.method === 'POST') {
      return new Promise((resolve) => { release = () => { void baseFetch(url, init).then(resolve) } })
    }
    return baseFetch(url, init)
  })
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  fireEvent.change(composer, { target: { value: 'Show these words now' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(within(screen.getByRole('article', { name: 'You' })).getByText('Show these words now')).toBeVisible()
  expect(screen.getByText('Sending…')).toBeVisible()
  expect(composer).toHaveValue('Show these words now')
  await waitFor(() => expect(release).toBeDefined())
  await act(async () => release!())
  await screen.findByText('Local reply')
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  expect(screen.queryByText('Sending…')).not.toBeInTheDocument()
  await waitFor(() => expect(composer).toHaveValue(''))
})

it('retries the failed bubble without duplicating it or replacing newer composer edits', async () => {
  await open()
  backend.setChatStatus(429)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  const bubble = screen.getByRole('article', { name: 'You' })
  expect(within(bubble).getByText('Saved words')).toBeVisible()
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(composer).toHaveValue('Saved words')
  fireEvent.change(composer, { target: { value: 'Newer words for later' } })
  backend.setChatStatus(200)
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | undefined
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/chat')) return new Promise((resolve) => { release = () => { void baseFetch(url, init).then(resolve) } })
    return baseFetch(url, init)
  })
  fireEvent.click(within(bubble).getByRole('button', { name: 'Retry' }))
  await screen.findByText('Sending…')
  expect(screen.getByRole('article', { name: 'You' })).toBe(bubble)
  expect(composer).toHaveValue('Newer words for later')
  await waitFor(() => expect(release).toBeDefined())
  await act(async () => release!())
  await screen.findByText('Local reply')
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  expect(composer).toHaveValue('Newer words for later')
  const attempts = backend.requests.filter((request) => request.path === '/chat')
  expect(attempts.map((request) => request.body.messages)).toEqual([
    [{ role: 'user', content: 'Saved words' }], [{ role: 'user', content: 'Saved words' }],
  ])
  expect(attempts[1]?.body.request_id).toBe(attempts[0]?.body.request_id)
})

it('recovers a failed bubble after reload and retries its original request while preserving newer words', async () => {
  const view = await open()
  backend.setChatStatus(429)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Newer words for later' } })
  view.unmount()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Not sent')
  const composer = screen.getByRole('textbox', { name: 'Your text' })
  expect(composer).toHaveValue('Newer words for later')
  const retry = screen.getByRole('button', { name: 'Retry' })
  await waitFor(() => expect(retry).toBeEnabled())
  backend.setChatStatus(200)
  fireEvent.click(retry)
  await screen.findByText('Local reply')
  expect(composer).toHaveValue('Newer words for later')
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  const attempts = backend.requests.filter((request) => request.path === '/chat')
  expect(attempts.map((request) => request.body.messages)).toEqual([
    [{ role: 'user', content: 'Saved words' }], [{ role: 'user', content: 'Saved words' }],
  ])
  expect(attempts[1]?.body.request_id).toBe(attempts[0]?.body.request_id)
})

it('reconciles a saved message after a lost acceptance without retaining a duplicate retry bubble', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/chat')) throw new TypeError('Connection lost after acceptance')
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Local reply')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument())
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
})

it('reconciles a lost confirmation after a reload without allowing a duplicate send', async () => {
  const view = await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/chat')) throw new TypeError('Connection lost after acceptance')
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  view.unmount()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Local reply')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(1)
})

it('retries a lost confirmation using the original request and displays the saved reply once', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let loseConfirmation = true
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/chat') && loseConfirmation) {
      loseConfirmation = false
      throw new TypeError('Connection lost after acceptance')
    }
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Local reply')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  expect(screen.getAllByRole('article', { name: 'Gemma' })).toHaveLength(1)
})

it('keeps a failed bubble in its own conversation across history reloads and chat switches', async () => {
  await open()
  backend.setChatStatus(429)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Not sent')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(screen.queryByText('Not sent')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await screen.findByText('Not sent')
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  backend.setChatStatus(200)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Local reply')
  expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
})

it.each([429, 503])('retries a refused first send in the same selected conversation after a %s response', async (status) => {
  backend.conversations.clear()
  backend.setChatStatus(status)
  render(<App />)
  act(() => backend.socket().ready())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Keep my first message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('dialog', { name: "Couldn't get a reply" })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Keep my first message')
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  backend.setChatStatus(200)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.filter((request) => request.path === '/conversations' && request.method === 'POST')).toHaveLength(1)
  expect(backend.requests.filter((request) => request.path === '/chat').map((request) => request.body.conversation_id)).toEqual(['chat-2', 'chat-2'])
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
})

it.each(['New chat', 'Send message', 'Start recording'])('keeps text typed while %s creates a conversation from the empty composer', async (action) => {
  backend.conversations.clear()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: () => void = () => {}
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/conversations') && init?.method === 'POST') {
      return new Promise((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  render(<App />)
  act(() => backend.socket().ready())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Initial words' } })
  fireEvent.click(screen.getByRole('button', { name: action }))
  await waitFor(() => expect(backend.conversations.has('chat-2')).toBe(true))
  expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Latest words while creating' } })
  await act(async () => release())
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest words while creating')
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  await waitFor(() => expect(backend.conversations.get('chat-2')?.draft).toBe('Latest words while creating'))
  if (action === 'Start recording') {
    await waitFor(() => expect(backend.requests).toContainEqual({ path: '/recording/start', method: 'POST', body: { conversation_id: 'chat-2' } }))
  }
  if (action === 'Send message') expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(0)
})

it('scopes a pre-selection draft to New chat even when the initial library resumes an existing conversation', async () => {
  const baseFetch = backend.fetchMock.getMockImplementation()!
  const releaseList: (() => void)[] = []
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/conversations') && !init?.method) return new Promise((resolve) => { releaseList.push(() => resolve(response)) })
    return response
  })
  render(<App />)
  act(() => backend.socket().ready())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Pre-selection words' } })
  await waitFor(() => expect(releaseList).toHaveLength(2))
  await act(async () => { for (const release of releaseList) release() })
  await screen.findByRole('button', { name: 'Select First chat' })
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await screen.findByRole('button', { name: 'Select New conversation' })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Pre-selection words')
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'Select New conversation' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Pre-selection words')
})

it('waits for an existing conversation draft to load before editing it', async () => {
  backend.conversations.set('loading-chat', { ...backend.conversations.get('chat-1')!, id: 'loading-chat', title: 'Loading chat', draft: 'Other saved words', messages: [] })
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | undefined
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (new URL(String(url)).pathname === '/conversations/loading-chat') return new Promise((resolve) => { release = () => resolve(response) })
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Select Loading chat' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toBeDisabled()
  await waitFor(() => expect(release).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toBeEnabled()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  await act(async () => release!())
  fireEvent.click(screen.getByRole('button', { name: 'Select Loading chat' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toBeEnabled()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Other saved words')
})

it('creates, selects, renames, deletes and restores durable conversations independently of the socket', async () => {
  const view = await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  openChatAction('Rename', 'New conversation')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Ideas' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByRole('button', { name: 'Select Ideas' })
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words'))
  expect(backend.socket().closed).toBe(false)
  expect(backend.socket().url).toBe('ws://127.0.0.1:8765/events')
  view.unmount()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  fireEvent.click(screen.getByRole('button', { name: 'Select Ideas' }))
  openChatAction('Delete', 'Ideas')
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Ideas' })).not.toBeInTheDocument())
})

it('opens chat actions on right click without selecting that conversation', async () => {
  backend.conversations.set('chat-2', { ...backend.conversations.get('chat-1')!, id: 'chat-2', title: 'Second chat', draft: 'Other words', messages: [] })
  await open()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Second chat' }))
  expect(screen.getByRole('button', { name: 'Select First chat', hidden: true })).toHaveAttribute('aria-current', 'page')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Renamed second chat' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByRole('button', { name: 'Select Renamed second chat' })
  expect(screen.getByRole('button', { name: 'Select First chat' })).toHaveAttribute('aria-current', 'page')
  openChatAction('Delete', 'Renamed second chat')
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Renamed second chat' })).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Select First chat' })).toHaveAttribute('aria-current', 'page')
})

it('rebases unsaved edits on atomic remote dictation without appending the transcript twice', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Edited words' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'Saved words\nDictated words'; saved.draft_version++
  act(() => {
    backend.socket().emit({ type: 'transcription.completed', recording_id: 'r1', conversation_id: 'chat-1', text: 'Dictated words' })
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
  })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Edited words\nDictated words'))
  await waitFor(() => expect(backend.socket().sent).toContainEqual({ type: 'transcript.ack', recording_id: 'r1', conversation_id: 'chat-1' }))
  await waitFor(() => expect(saved.draft).toBe('Edited words\nDictated words'))
  act(() => backend.socket().emit({ type: 'transcription.completed', recording_id: 'r1', conversation_id: 'chat-1', text: 'Dictated words' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Edited words\nDictated words')
})

it('preserves both drafts when a version conflict cannot merge, and allows deliberate resolution', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'My local edit' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'Other tab replacement'; saved.draft_version++
  await screen.findByText('Draft conflict')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('My local edit')
  expect(screen.getByText('Other tab replacement')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep both drafts' }))
  await waitFor(() => expect(saved.draft).toBe('My local edit\nOther tab replacement'))
})

it('toggles capture on clicks only, keeps the recording owner connected while switching, and routes dictation to its origin', async () => {
  await open()
  const mic = screen.getByRole('button', { name: 'Start recording' })
  fireEvent.pointerDown(mic); fireEvent.pointerUp(mic)
  expect(backend.requests.filter((request) => request.path.startsWith('/recording/'))).toHaveLength(0)
  fireEvent.click(mic)
  await waitFor(() => expect(backend.requests).toContainEqual({ path: '/recording/start', method: 'POST', body: { conversation_id: 'chat-1' } }))
  const owner = backend.socket()
  act(() => owner.emit({ type: 'state.updated', state: { ...initialState, revision: 2, capture_owned: true, client_connected: true, recording: true, conversation_id: 'chat-1' } }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(owner.closed).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
  await waitFor(() => expect(backend.requests).toContainEqual({ path: '/recording/stop', method: 'POST', body: {} }))
  const origin = backend.conversations.get('chat-1')!
  origin.draft = 'Saved words\nOld capture'; origin.draft_version++
  act(() => owner.emit({ type: 'transcription.completed', recording_id: 'old', conversation_id: 'chat-1', text: 'Old capture' }))
  await waitFor(() => expect(owner.sent).toContainEqual({ type: 'transcript.ack', recording_id: 'old', conversation_id: 'chat-1' }))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words\nOld capture'))
  expect(screen.queryByText(/Fn|Hold to|hands-free/)).not.toBeInTheDocument()
})

it('shows app-wide microphone occupancy without rejecting the tab connection', async () => {
  await open()
  act(() => backend.socket().emit({ type: 'state.updated', state: { ...initialState, revision: 2, capture_owned: false, client_connected: true, recording: true, conversation_id: 'elsewhere' } }))
  expect(screen.getByText('Microphone occupied in another tab')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  expect(screen.queryByText('Connected · local')).not.toBeInTheDocument()
})

it('sends only the latest user message with backend identity, displays the reply and clears the accepted draft', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  expect(backend.requests.find((request) => request.path === '/chat')?.body).toMatchObject({ conversation_id: 'chat-1', messages: [{ role: 'user', content: 'Saved words' }] })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  expect(backend.conversations.get('chat-1')?.draft).toBe('')
})

it.each([[429, 'OutLoud is busy answering another chat'], [409, 'A reply is already in progress in this chat'], [503, 'Please try sending again in a moment'], [403, 'Please reconnect before sending'], [404, 'This chat was deleted']])('keeps the draft and reports a %s refusal without retrying the model', async (status, message) => {
  await open()
  backend.setChatStatus(Number(status))
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText(String(message), { exact: false })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  expect(backend.requests.filter((request) => request.path === '/chat')).toHaveLength(1)
  expect(screen.queryByText('Local reply')).not.toBeInTheDocument()
})

it('backs off failed initial connections, exhausts a bounded retry budget and retains tab selection and unsaved text across reload', async () => {
  vi.useFakeTimers()
  const view = render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Offline edits' } })
  for (const delay of [500, 1000, 2000, 4000]) {
    act(() => backend.socket().onerror?.())
    const count = FakeSocket.instances.length
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
    expect(FakeSocket.instances).toHaveLength(count)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(FakeSocket.instances).toHaveLength(count + 1)
  }
  act(() => backend.socket().onerror?.())
  expect(screen.queryByText('Connection retries exhausted')).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(FakeSocket.instances).toHaveLength(5)
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Offline edits')
  view.unmount()
  vi.useRealTimers()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Offline edits')
})

it('reconnects after loss using the old client safety check even if another tab is connected and recording', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/state')
    ? Response.json({ ...initialState, client_connected: false, capture_owned: false, ui_connected: true, recording: true })
    : baseFetch(url, init))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Retain this' } })
  vi.useFakeTimers()
  act(() => backend.socket().close())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(FakeSocket.instances).toHaveLength(2)
  const stateCall = backend.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/state'))!
  expect(stateCall[1]?.headers).toEqual({ 'X-Session-ID': 'test-session' })
  act(() => backend.socket().ready())
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Retain this')
  expect(screen.queryByText('Connected · local')).not.toBeInTheDocument()
  vi.useRealTimers()
})

it('keeps independent streams scoped while switching and ignores history reloads until a run finishes', async () => {
  await open()
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'First answer'))
  await screen.findByText('First answer')
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Second question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-2', 'Second answer'))
  await screen.findByText('Second answer')
  expect(screen.queryByText('First answer')).not.toBeInTheDocument()
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await screen.findByText('First answer')
  expect(screen.queryByText('Second answer')).not.toBeInTheDocument()
  act(() => { backend.done('chat-1'); backend.done('chat-2') })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  expect(screen.getAllByText('First answer')).toHaveLength(1)
})

it('clears the accepted draft by CAS without erasing dictation committed during the clear', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let appended = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (!appended && init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '') {
      appended = true
      const saved = backend.conversations.get('chat-1')!
      saved.draft = 'Saved words\nArrived while sending'; saved.draft_version++
    }
    return baseFetch(url, init)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Local reply')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Arrived while sending'))
  expect(backend.conversations.get('chat-1')?.draft).toBe('Arrived while sending')
})

it('retains edits typed while chat acceptance is pending', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let accept: (response: Response) => void = () => {}
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (String(url).endsWith('/chat')) return new Promise((resolve) => { accept = resolve.bind(null, response) })
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'New edits during loading' } })
  await act(async () => accept(new Response()))
  await screen.findByText('Local reply')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('New edits during loading')
})

it('refreshes the shared library on remote create/rename/delete without changing this tab’s selection', async () => {
  await open()
  backend.conversations.set('remote', { ...backend.conversations.get('chat-1')!, id: 'remote', title: 'Another tab', draft: 'Remote draft', messages: [] })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await screen.findByRole('button', { name: 'Select Another tab' })
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  backend.conversations.get('remote')!.title = 'Renamed remotely'
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await screen.findByRole('button', { name: 'Select Renamed remotely' })
  backend.conversations.delete('remote')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'remote' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Renamed remotely' })).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
})

it('retains unsaved draft recovery through reload after a storage failure and retries saving explicitly', async () => {
  const view = await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let storeBusy = true
  backend.fetchMock.mockImplementation(async (url, init) => init?.method === 'PATCH' && storeBusy
    ? Response.json({ detail: 'Store busy' }, { status: 503 }) : baseFetch(url, init))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Unsaved offline recovery' } })
  await screen.findByRole('button', { name: 'Try saving again' })
  view.unmount()
  await open()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Unsaved offline recovery')
  await screen.findByRole('button', { name: 'Try saving again' })
  storeBusy = false
  fireEvent.click(screen.getByRole('button', { name: 'Try saving again' }))
  await waitFor(() => expect(backend.conversations.get('chat-1')?.draft).toBe('Unsaved offline recovery'))
})

it('keeps the last local edit when typing races an in-flight save and its WS echo', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: () => void = () => {}
  let held = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if (init?.method === 'PATCH' && !held) {
      held = true
      return new Promise((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'First edit' } })
  await waitFor(() => expect(held).toBe(true))
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Latest edit' } })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  act(() => release())
  await waitFor(() => expect(backend.conversations.get('chat-1')?.draft).toBe('Latest edit'))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit')
  expect(screen.queryByText('Draft conflict')).not.toBeInTheDocument()
})

it('allows deliberate cancellation of the displayed conversation only', async () => {
  await open()
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  await screen.findByText('cancelled · partial reply')
  expect(screen.getByText('Partial answer')).toBeInTheDocument()
  expect(backend.requests.filter((request) => request.path === '/chat/cancel')).toHaveLength(1)
})

it('bounds stalled initial handshakes without showing connection indicators', async () => {
  vi.useFakeTimers()
  render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(32500) })
  expect(FakeSocket.instances).toHaveLength(5)
  expect(screen.queryByText('Connection retries exhausted')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
})

it('never reopens capture after loss until the old client releases it, and exhausts safety checks', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  backend.fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/state')
    ? Response.json({ ...initialState, client_connected: false, capture_owned: true, recording: true })
    : baseFetch(url, init))
  vi.useFakeTimers()
  act(() => backend.socket().close())
  await act(async () => { await vi.advanceTimersByTimeAsync(14000) })
  expect(screen.getByText('Recording stop is unconfirmed')).toBeInTheDocument()
  expect(screen.queryByText('Connection retries exhausted')).not.toBeInTheDocument()
  expect(FakeSocket.instances).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
})

it('preserves a local draft when another tab deletes its selected conversation', async () => {
  await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Recover after deletion' } })
  backend.conversations.delete('chat-1')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Recovered unsaved drafts from unavailable conversations' }))
  expect(screen.getByText('Recover after deletion')).toBeInTheDocument()
  expect(backend.socket().closed).toBe(false)
})

it('does not let a delayed draft-save response resurrect finished messages as streaming', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    // Hold the accepted-draft clear; its response snapshots the streaming placeholder.
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '' && release === null) {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(release).not.toBeNull())
  act(() => backend.delta('chat-1', 'Full authoritative answer'))
  await screen.findByText('Full authoritative answer')
  act(() => backend.done('chat-1'))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  await act(async () => release!())
  await waitFor(() => expect(screen.getByText('Full authoritative answer')).toBeInTheDocument())
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
})

it('retires an orphaned overlay after a failed final reload once authoritative history recovers', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let storeBusy = false
  backend.fetchMock.mockImplementation(async (url, init) => {
    if (storeBusy && (init?.method ?? 'GET') !== 'PATCH' && String(url).endsWith('/conversations/chat-1')) {
      storeBusy = false
      return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    return baseFetch(url, init)
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  storeBusy = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  const saved = backend.conversations.get('chat-1')!
  saved.messages = [
    { id: 'authoritative-user', role: 'user', content: 'Saved words', status: 'complete', metrics: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'authoritative-assistant', role: 'assistant', content: 'Full authoritative answer', status: 'complete', metrics: { elapsed_seconds: 1 }, created_at: '2026-01-01T00:00:00Z' },
  ]
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
  expect(screen.queryByText('failed · partial reply')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
})

it('keeps a newly created conversation selected when an older library refresh lands late', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations')) {
      const response = await baseFetch(url, init)
      if (release === null) return new Promise<Response>((resolve) => { release = () => resolve(response) })
      return response
    }
    return baseFetch(url, init)
  })
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(release).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(''))
  await act(async () => release!())
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-2' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(screen.getByRole('button', { name: 'Select New conversation' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('button', { name: 'Select First chat' })).not.toHaveAttribute('aria-current')
})

it('merges each dictated append once across repeated reloads during a delayed save', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    const response = await baseFetch(url, init)
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) detailReads++
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === 'First edit') {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'First edit' } })
  await waitFor(() => expect(release).not.toBeNull())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Latest edit' } })
  const saved = backend.conversations.get('chat-1')!
  saved.draft = 'First edit\nDictated once'; saved.draft_version++
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once'))
  const readsBeforeRepeat = detailReads
  await act(async () => {
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
    await Promise.resolve(); await Promise.resolve()
  })
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeRepeat))
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once')
  // A second real append must still merge, even though the same save is pending.
  saved.draft += '\nNext dictation'; saved.draft_version++
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest edit\nDictated once\nNext dictation'))
  await act(async () => release!())
  await waitFor(() => expect(saved.draft).toBe('Latest edit\nDictated once\nNext dictation'))
})

it('keeps a failed partial reply when another conversation reloads, until its own history recovers', async () => {
  backend.conversations.set('chat-2', { ...backend.conversations.get('chat-1')!, id: 'chat-2', title: 'Second chat', draft: 'Second draft', messages: [] })
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let failFirstChat = false
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) {
      detailReads++
      if (failFirstChat) return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    return baseFetch(url, init)
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(backend.conversations.get('chat-1')!.draft).toBe(''))
  const readsBeforeCache = detailReads
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeCache))
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  failFirstChat = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Select Second chat' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Second draft'))
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await screen.findByText('Partial answer')
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
  const saved = backend.conversations.get('chat-1')!
  saved.messages = saved.messages.map((message) => ({ ...(message as Record<string, unknown>), status: 'complete', ...((message as Record<string, unknown>).role === 'assistant' ? { content: 'Full authoritative answer' } : {}) }))
  failFirstChat = false
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
})

it('preserves a failed partial reply when a delayed draft clear returns stale streaming history', async () => {
  await open()
  const baseFetch = backend.fetchMock.getMockImplementation()!
  let release: (() => void) | null = null
  let failHistory = false
  let detailReads = 0
  backend.fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/conversations/chat-1')) {
      detailReads++
      if (failHistory) return Response.json({ detail: 'Store busy' }, { status: 503 })
    }
    const response = await baseFetch(url, init)
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).draft === '' && release === null) {
      return new Promise<Response>((resolve) => { release = () => resolve(response) })
    }
    return response
  })
  backend.holdChats()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByRole('button', { name: 'Stop generation' })
  await waitFor(() => expect(release).not.toBeNull())
  const readsBeforeCache = detailReads
  await act(async () => {
    backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' })
    await Promise.resolve(); await Promise.resolve()
  })
  await waitFor(() => expect(detailReads).toBeGreaterThan(readsBeforeCache))
  act(() => backend.delta('chat-1', 'Partial answer'))
  await screen.findByText('Partial answer')
  failHistory = true
  act(() => backend.interrupt('chat-1'))
  await screen.findAllByText('failed · partial reply')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
  await act(async () => release!())
  expect(screen.getByText('Partial answer')).toBeInTheDocument()
  expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Next question' } })
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  const saved = backend.conversations.get('chat-1')!
  saved.messages = saved.messages.map((message) => ({ ...(message as Record<string, unknown>), status: 'complete', ...((message as Record<string, unknown>).role === 'assistant' ? { content: 'Full authoritative answer' } : {}) }))
  failHistory = false
  act(() => backend.socket().emit({ type: 'conversation.updated', conversation_id: 'chat-1' }))
  await screen.findByText('Full authoritative answer')
  expect(screen.queryByText('Partial answer')).not.toBeInTheDocument()
})

it('cancels rename and deletion without changing the saved conversation', async () => {
  await open()
  openChatAction('Rename')
  const title = await screen.findByRole('textbox', { name: 'Conversation title' })
  await waitFor(() => expect(title).toHaveFocus())
  fireEvent.change(title, { target: { value: 'Discard this name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  openChatAction('Rename')
  expect(await screen.findByRole('textbox', { name: 'Conversation title' })).toHaveValue('First chat')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  openChatAction('Delete')
  expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep conversation' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(backend.requests.filter((request) => request.method === 'PATCH' || request.method === 'DELETE')).toHaveLength(0)
  expect(backend.conversations.get('chat-1')?.title).toBe('First chat')
})

it('keeps a failed deletion open for review and allows retry', async () => {
  await open()
  backend.fetchMock.mockImplementationOnce(async () => Response.json({ detail: 'Conversation storage is busy' }, { status: 503 }))
  openChatAction('Delete')
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  await screen.findByText('Conversation storage is busy')
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  expect(backend.conversations.has('chat-1')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
  await waitFor(() => expect(backend.conversations.has('chat-1')).toBe(false))
})

it('returns keyboard focus to the rename action after a successful title change', async () => {
  await open()
  openChatAction('Rename')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Reviewed name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByRole('button', { name: 'Select Reviewed name' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename conversation' })).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select Reviewed name' })).toHaveFocus())
})

it('returns keyboard focus to a surviving header control after deleting the last conversation', async () => {
  await open()
  openChatAction('Delete')
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Toggle Sidebar' })).toHaveFocus())
  expect(backend.conversations.size).toBe(0)
})

it('hides collapsed desktop navigation from accessibility and restores it on expansion', async () => {
  await open()
  const toggle = screen.getByRole('button', { name: 'Toggle Sidebar' })
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
})

it('selects a conversation from the mobile drawer and closes it without losing the draft', async () => {
  vi.mocked(window.matchMedia).mockImplementation((query) => ({
    matches: true, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  render(<App />)
  act(() => backend.socket().ready())
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words'))
  expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: 'Toggle Sidebar' })
  fireEvent.click(toggle)
  await screen.findByRole('dialog', { name: 'Sidebar' })
  fireEvent.click(screen.getByRole('button', { name: 'Select First chat' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(toggle).toHaveFocus())
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue('Saved words')
  expect(backend.socket().closed).toBe(false)
})

it.each([false, true])('recovers edits from a closed desktop window without changing browser storage, managed desktop = %s', async (managedDesktop) => {
  if (managedDesktop) vi.stubGlobal('outloudDesktop', { managedBackend: true })
  const view = await open()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'Words typed just before closing' } })
  view.unmount()
  // Native window destruction ends its session; its persistent profile survives.
  sessionStorage.clear()
  await open()
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(managedDesktop ? 'Words typed just before closing' : 'Saved words'))
})

it.each([false, true])('recovers a first-message draft after desktop closure, managed desktop = %s', async (managedDesktop) => {
  if (managedDesktop) vi.stubGlobal('outloudDesktop', { managedBackend: true })
  backend.conversations.clear()
  const view = render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  fireEvent.change(screen.getByRole('textbox', { name: 'Your text' }), { target: { value: 'First words before closing' } })
  view.unmount()
  sessionStorage.clear()
  render(<App />)
  act(() => backend.socket().ready())
  await screen.findByText('Your conversations will appear here.')
  expect(screen.getByRole('textbox', { name: 'Your text' })).toHaveValue(managedDesktop ? 'First words before closing' : '')
})

it.each([false, true])('keeps exhausted connection retries out of the UI, managed desktop = %s', async (managedDesktop) => {
  if (managedDesktop) vi.stubGlobal('outloudDesktop', { managedBackend: true })
  await open()
  vi.useFakeTimers()
  for (const delay of [500, 1000, 2000, 4000]) {
    await act(async () => backend.socket().onerror?.())
    await act(async () => vi.advanceTimersByTimeAsync(delay))
  }
  await act(async () => backend.socket().onerror?.())
  const notifications = screen.getByRole('region', { name: 'Notifications' })
  expect(within(notifications).queryByRole('dialog')).not.toBeInTheDocument()
})
