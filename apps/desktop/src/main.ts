import { app, BrowserWindow, dialog, ipcMain, Menu, shell, systemPreferences } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { BackendProcess } from './backend-process.js'
import { DesktopSession } from './desktop-session.js'
import type { DesktopState } from './desktop-state.js'
import { MicrophonePermission } from './microphone-permission.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const controlPage = fileURLToPath(new URL('../src/control.html', import.meta.url))
const controlUrl = new URL('../src/control.html', import.meta.url).href
const uiUrl = 'http://127.0.0.1:5174'
let window: BrowserWindow | null = null
let session: DesktopSession | null = null
let quitting = false
let showingChat = false
let forceConfirmationOpen = false
const microphonePermission = new MicrophonePermission({
  platform: process.platform,
  getStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
  request: () => systemPreferences.askForMediaAccess('microphone'),
  openExternal: (url) => shell.openExternal(url),
})

app.setName('OutLoud')
const dataDirectory = app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'OutLoud')
mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)

// The development launcher requests a normal quit, never a timed forced kill.
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
if (process.env.OUTLOUD_DESKTOP_LAUNCHER === '1') {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (message: string) => { if (message.trim() === 'quit') app.quit() })
  process.stdin.on('end', () => app.quit())
}

// A second launcher must never acquire or stop the first launcher's backend.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.on('activate', () => { if (!window && !quitting) openWindow() })
  app.on('before-quit', (event) => {
    if (window && session?.state.phase !== 'closed') {
      event.preventDefault()
      quitting = true
      void session?.close()
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || quitting) app.quit()
  })
  void app.whenReady().then(() => {
    app.setName('OutLoud')
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'OutLoud', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]))
    openWindow()
  })
}

function openWindow() {
  if (window || quitting) return
  showingChat = false
  const current = new BrowserWindow({
    title: 'OutLoud', width: 1200, height: 820, minWidth: 760, minHeight: 540,
    backgroundColor: '#101012', show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  window = current
  const backend = new BackendProcess({
    command: join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    args: ['-m', 'outloud'], dataDirectory: app.getPath('userData'),
  })
  const currentSession = new DesktopSession(backend, (state) => showState(current, currentSession, state))
  session = currentSession
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  current.webContents.on('will-navigate', (event, url) => {
    if (url !== controlUrl && new URL(url).origin !== uiUrl) event.preventDefault()
  })
  current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  current.on('close', (event) => {
    if (currentSession.state.phase !== 'closed') {
      event.preventDefault()
      void currentSession.close()
    }
  })
  current.on('closed', () => {
    if (window === current) { window = null; session = null }
  })
  current.once('ready-to-show', () => current.show())
  current.webContents.on('did-finish-load', () => {
    if (current.webContents.getURL() === controlUrl) current.webContents.send('desktop:state', currentSession.state)
  })
  void current.loadFile(controlPage).then(() => currentSession.start()).catch((error: unknown) => {
    dialog.showErrorBox('OutLoud could not open', String(error))
    void currentSession.close()
  })
}

function showState(current: BrowserWindow, currentSession: DesktopSession, state: DesktopState) {
  if (current.isDestroyed()) return
  if (state.phase === 'closed') {
    current.destroy()
    return
  }
  if (state.phase === 'running') {
    showingChat = true
    void current.loadURL(uiUrl).catch((error: unknown) => {
      dialog.showErrorBox('OutLoud UI unavailable', String(error))
      void currentSession.close()
    })
  } else if (state.phase === 'error' && showingChat) {
    // Leave the composer mounted so unsaved edits survive a backend failure.
    dialog.showErrorBox('OutLoud backend stopped', state.message)
  } else if (current.webContents.getURL() === controlUrl) {
    current.webContents.send('desktop:state', state)
  } else {
    showingChat = false
    void current.loadFile(controlPage)
  }
}

function isControlSender(event: Electron.IpcMainInvokeEvent) {
  return window && event.sender === window.webContents &&
    event.senderFrame?.url === controlUrl && event.senderFrame === event.sender.mainFrame
}

function isChatSender(event: Electron.IpcMainInvokeEvent) {
  return window && session?.state.phase === 'running' && event.sender === window.webContents &&
    event.senderFrame?.url === `${uiUrl}/` && event.senderFrame === event.sender.mainFrame
}

ipcMain.handle('desktop:microphone-permission', (event) => {
  if (!isChatSender(event)) throw new Error('Active desktop chat required')
  return microphonePermission.request()
})
ipcMain.handle('desktop:microphone-settings', (event) => {
  if (!isChatSender(event)) throw new Error('Active desktop chat required')
  return microphonePermission.openSettings()
})

ipcMain.handle('desktop:state', (event) => {
  if (!isControlSender(event)) throw new Error('Desktop control page required')
  return session?.state
})
ipcMain.handle('desktop:force-quit', async (event) => {
  if (!isControlSender(event) || !window || session?.state.phase !== 'stopping' || forceConfirmationOpen) return
  const currentSession = session
  forceConfirmationOpen = true
  try {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Force quit OutLoud?',
      message: 'Unfinished transcription may be lost.',
      detail: 'Saved conversations and audio files remain, but unfinished audio jobs are not automatically resumed. Keep waiting to let transcription finish.',
      buttons: ['Keep waiting', 'Force quit'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (answer.response === 1) await currentSession.forceQuit()
  } finally { forceConfirmationOpen = false }
})
