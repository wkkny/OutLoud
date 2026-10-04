// Requires a graphical desktop and the installed Python environment, not models/audio.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startUi } from './ui-server.mjs'

const folder = await mkdtemp(join(tmpdir(), 'outloud-electron-smoke-'))
const ui = await startUi()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.OUTLOUD_DESKTOP_LAUNCHER
let application
let pausedPid
async function backendStopped() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(500) }) }
    catch { return }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Backend remained alive after the desktop window closed')
}
try {
  application = await _electron.launch({
    args: [fileURLToPath(new URL('../', import.meta.url)), `--user-data-dir=${folder}`],
    env, timeout: 30_000,
  })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') console.error('Renderer:', message.text()) })
  await page.waitForURL('http://127.0.0.1:5174/', { timeout: 120_000 })
  const newChat = page.getByRole('button', { name: 'New chat', exact: true })
  await newChat.waitFor()
  assert.deepEqual(await page.evaluate(() => ({
    managed: window.outloudDesktop.managedBackend,
    node: typeof window.require,
  })), { managed: true, node: 'undefined' })
  await newChat.click()
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Conversation title' })
  await title.fill('Desktop smoke')
  await page.getByRole('button', { name: 'Save name', exact: true }).click()
  await page.getByRole('button', { name: 'Select Desktop smoke' }).waitFor()
  await page.getByRole('textbox', { name: 'Your text' }).fill('Saved desktop draft')
  await page.getByText('Unsaved changes kept in this tab', { exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: 'Start recording', exact: true }).isEnabled(), true)
  if (process.platform === 'darwin' || process.platform === 'win32') {
    // Exercise real IPC/preload/UI wiring without prompting the OS or capturing audio.
    await application.evaluate(({ systemPreferences, shell }) => {
      globalThis.smokePermissionOriginals = {
        status: systemPreferences.getMediaAccessStatus, request: systemPreferences.askForMediaAccess,
        open: shell.openExternal,
      }
      globalThis.smokeSettingsTargets = []
      systemPreferences.getMediaAccessStatus = () => 'denied'
      systemPreferences.askForMediaAccess = async () => { throw new Error('No real microphone prompt allowed') }
      shell.openExternal = async (url) => { globalThis.smokeSettingsTargets.push(url) }
    })
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const permissionNotice = page.getByRole('dialog', { name: 'Recording needs attention', exact: true })
    await permissionNotice.waitFor()
    assert.equal((await (await fetch('http://127.0.0.1:8765/state')).json()).recording, false)
    await permissionNotice.getByRole('button', { name: 'Open microphone settings', exact: true }).click()
    const targets = await application.evaluate(() => globalThis.smokeSettingsTargets)
    assert.deepEqual(targets, [process.platform === 'darwin'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      : 'ms-settings:privacy-microphone'])
    const blocked = await application.evaluate(async ({ BrowserWindow }, preload) => {
      const untrusted = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } })
      try {
        await untrusted.loadURL('about:blank')
        return await untrusted.webContents.executeJavaScript('window.outloudDesktop.requestMicrophoneAccess().then(() => false, () => true)')
      } finally { untrusted.destroy() }
    }, fileURLToPath(new URL('../dist/preload.cjs', import.meta.url)))
    assert.equal(blocked, true)
    await application.evaluate(({ systemPreferences, shell }) => {
      const original = globalThis.smokePermissionOriginals
      systemPreferences.getMediaAccessStatus = original.status
      systemPreferences.askForMediaAccess = original.request
      shell.openExternal = original.open
      delete globalThis.smokePermissionOriginals
      delete globalThis.smokeSettingsTargets
    })
  }
  assert.deepEqual(errors, [])
  // Closing before autosave must recover the last edits in the next native window.
  await page.getByRole('textbox', { name: 'Your text' }).fill('Desktop edits immediately before close')
  const closed = page.waitForEvent('close')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  await backendStopped()

  if (process.platform === 'darwin') {
    const opening = application.waitForEvent('window')
    await application.evaluate(({ app }) => app.emit('activate'))
    const reopened = await opening
    await reopened.waitForURL('http://127.0.0.1:5174/', { timeout: 120_000 })
    const saved = reopened.getByRole('button', { name: 'Select Desktop smoke' })
    await saved.waitFor()
    await saved.click()
    await reopened.waitForFunction(() => document.querySelector('#composer')?.value === 'Desktop edits immediately before close')
    await reopened.getByText('Unsaved changes kept in this tab', { exact: true }).waitFor({ state: 'hidden' })
    // Pause only this smoke launch's Python, then exercise the native loss-warning
    // boundary. Dialog answers are simulated; all window/process behavior is real.
    pausedPid = Number(execFileSync('lsof', ['-t', '-iTCP:8765', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim())
    assert.ok(pausedPid > 0)
    process.kill(pausedPid, 'SIGSTOP')
    await application.evaluate(({ dialog }) => {
      globalThis.smokeDialogs = []
      globalThis.smokeAnswer = 0
      dialog.showMessageBox = async (_window, options) => {
        globalThis.smokeDialogs.push(options)
        return { response: globalThis.smokeAnswer, checkboxChecked: false }
      }
    })
    const reclosed = reopened.waitForEvent('close')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    const force = reopened.getByRole('button', { name: 'Force quit…', exact: true })
    await force.waitFor()
    await force.click()
    await reopened.waitForFunction(() => !document.querySelector('#force')?.disabled)
    const warnings = await application.evaluate(() => globalThis.smokeDialogs)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].message, 'Unfinished transcription may be lost.')
    assert.deepEqual(warnings[0].buttons, ['Keep waiting', 'Force quit'])
    assert.equal(warnings[0].defaultId, 0)
    assert.equal(reopened.isClosed(), false)
    process.kill(pausedPid, 0) // Keep waiting did not kill Python.
    await application.evaluate(() => { globalThis.smokeAnswer = 1 })
    await force.click()
    await reclosed
    pausedPid = undefined
    await backendStopped()
  }
  console.log('PASS: Electron window, isolated renderer, managed Python, conversation/draft persistence, microphone denial/settings and IPC boundary, close/stop, macOS reopen, and force-quit warning/cancel/confirm. No microphone/model test performed.')
} finally {
  if (pausedPid) { try { process.kill(pausedPid, 'SIGCONT') } catch { /* Already exited. */ } }
  if (application) await application.close()
  await ui.close()
  await rm(folder, { recursive: true, force: true })
}
