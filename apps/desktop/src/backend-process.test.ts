import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { BackendProcess } from './backend-process.js'
import { DesktopSession } from './desktop-session.js'

const folders: string[] = []
const backends: BackendProcess[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.forceStop()))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  const url = `http://127.0.0.1:${address.port}`
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'outloud-desktop-')))
  folders.push(folder)
  const backend = new BackendProcess({
    command: process.execPath,
    args: [fileURLToPath(new URL('../test/backend-fixture.mjs', import.meta.url))],
    dataDirectory: folder,
    url,
    env: { ...extraEnv, FIXTURE_PORT: String(address.port) },
    startupTimeoutMs: 5000,
  })
  backends.push(backend)
  return { backend, folder, url }
}

it('starts its own ready backend in a separate data directory without inheriting browser storage', async () => {
  const { backend, folder, url } = await setup({ OUTLOUD_CONVERSATIONS_DB: '/browser-data.sqlite3' })
  await backend.start()
  const response = await fetch(`${url}/fixture`)
  expect(await response.json()).toEqual({ cwd: folder, conversationOverride: null })
  await backend.stop()
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
})

it('shows shutdown progress until its backend finishes transcription, then closes', async () => {
  const { backend, url } = await setup({ FIXTURE_DRAIN_MS: '400' })
  const session = new DesktopSession(backend, () => {})
  await session.start()
  expect(session.state.phase).toBe('running')
  const closing = session.close()
  expect(session.state).toEqual({ phase: 'stopping', message: 'Finishing transcription…' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(session.state.phase).toBe('stopping')
  expect((await fetch(`${url}/fixture`)).ok).toBe(true)
  await closing
  expect(session.state.phase).toBe('closed')
})

it('does not start a hidden backend if its window closed before startup', async () => {
  const { backend, url } = await setup()
  const session = new DesktopSession(backend, () => {})
  await session.close()
  await session.start()
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
  expect(session.state.phase).toBe('closed')
})

it('closes when its backend exits after the graceful shutdown request times out', async () => {
  const { backend } = await setup({ FIXTURE_SHUTDOWN_RESPONSE_MS: '2300' })
  const session = new DesktopSession(backend, () => {})
  await session.start()
  await session.close()
  expect(session.state.phase).toBe('stopping')
  expect(await backend.exited).toEqual({ code: 0, signal: null })
  await vi.waitFor(() => expect(session.state.phase).toBe('closed'))
})

it('allows an explicit force quit during a stuck drain without a silent deadline', async () => {
  const { backend, url } = await setup({ FIXTURE_DRAIN_MS: '60000' })
  const session = new DesktopSession(backend, () => {})
  await session.start()
  const closing = session.close()
  await vi.waitFor(async () => expect((await fetch(`${url}/fixture`)).ok).toBe(true))
  expect(session.state.phase).toBe('stopping')
  await session.forceQuit()
  await closing
  expect(session.state.phase).toBe('closed')
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
})

it('reports a startup failure and can close without any hidden backend', async () => {
  const { backend, url } = await setup({ FIXTURE_EXIT_CODE: '7' })
  const session = new DesktopSession(backend, () => {})
  await session.start()
  expect(session.state.phase).toBe('error')
  expect(session.state.message).toContain('exited (7)')
  await session.close()
  expect(session.state.phase).toBe('closed')
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
})

it('reports an unexpected backend exit rather than leaving the window apparently healthy', async () => {
  const { backend } = await setup()
  const session = new DesktopSession(backend, () => {})
  await session.start()
  await backend.forceStop()
  await vi.waitFor(() => expect(session.state.phase).toBe('error'))
  expect(session.state.message).toContain('Close and reopen OutLoud')
  await session.close()
  expect(session.state.phase).toBe('closed')
})

it('closing during Python startup drains it without reopening the chat window', async () => {
  const { backend, url } = await setup()
  const session = new DesktopSession(backend, () => {})
  const launching = session.start()
  const closing = session.close()
  await Promise.all([launching, closing])
  expect(session.state.phase).toBe('closed')
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
})

it('cancels pending startup when force quit is confirmed before Python has spawned', async () => {
  const { backend, url } = await setup()
  const session = new DesktopSession(backend, () => {})
  const launching = session.start()
  const closing = session.close()
  const forcing = session.forceQuit()
  await Promise.all([launching, closing, forcing])
  expect(session.state.phase).toBe('closed')
  await expect(fetch(`${url}/fixture`)).rejects.toThrow()
})

it('refuses an occupied port without attaching to or stopping the existing process', async () => {
  const { backend, url } = await setup()
  const unrelated = createServer()
  await new Promise<void>((resolve) => unrelated.listen(Number(new URL(url).port), '127.0.0.1', resolve))
  try {
    await expect(backend.start()).rejects.toThrow('already in use')
    await backend.forceStop()
    expect(unrelated.listening).toBe(true)
  } finally { await new Promise<void>((resolve) => unrelated.close(() => resolve())) }
})
