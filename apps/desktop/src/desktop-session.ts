import type { BackendProcess } from './backend-process.js'

import type { DesktopState } from './desktop-state.js'

// Window lifecycle without Electron coupling. BackendProcess owns OS process details.
export class DesktopSession {
  state: DesktopState = { phase: 'starting', message: 'Starting your local backend…' }
  private launching: Promise<void> | null = null
  private closing: Promise<void> | null = null

  constructor(private backend: BackendProcess, private onChange: (state: DesktopState) => void) {}

  private update(phase: DesktopState['phase'], message: string) {
    this.state = { phase, message }
    this.onChange(this.state)
  }

  async start() {
    if (this.state.phase !== 'starting' || this.launching) return
    this.launching = this.backend.start()
    try {
      await this.launching
      if (this.state.phase === 'starting') this.update('running', '')
      void this.backend.exited.then(({ code, signal }) => {
        if (this.state.phase === 'running') this.update('error', `The Python backend exited unexpectedly (${signal ?? code}). Close and reopen OutLoud to restart it. Your saved conversations are retained.`)
        else if (this.state.phase === 'stopping') this.update('closed', '')
      })
    } catch (error) {
      if (this.state.phase === 'starting') this.update('error', error instanceof Error ? error.message : 'Could not start Python.')
    }
  }

  close() {
    if (this.closing) return this.closing
    this.update('stopping', 'Finishing transcription…')
    this.closing = (async () => {
      // A window may be closed while Python is still importing native libraries.
      await this.launching?.catch(() => {})
      if (this.isClosed()) return
      await this.backend.stop()
      if (!this.isClosed()) this.update('closed', '')
    })().catch((error) => {
      this.closing = null
      if (this.state.phase !== 'closed') this.update('stopping', `Could not request graceful shutdown. ${error instanceof Error ? error.message : ''} Close the window to retry, or use Force quit.`)
    })
    return this.closing
  }

  private isClosed() { return this.state.phase === 'closed' }

  async forceQuit() {
    if (this.state.phase !== 'stopping') return
    try {
      await this.backend.forceStop()
      this.update('closed', '')
    } catch (error) {
      this.update('stopping', `Could not force quit Python. ${error instanceof Error ? error.message : ''}`)
    }
  }
}
