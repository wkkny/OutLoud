import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

type Exit = { code: number | null; signal: NodeJS.Signals | null }
type Options = {
  command: string
  args: string[]
  dataDirectory: string
  url?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
}

// Owns one process, from authenticated readiness through drain or explicit force.
// Create a new instance when a closed desktop window is reopened.
export class BackendProcess {
  readonly url: string
  readonly exited: Promise<Exit>
  private child: ChildProcess | null = null
  private startupCancelled = false
  private token = randomBytes(32).toString('hex')
  private exitError: Error | null = null
  private stderr = ''
  private resolveExit!: (exit: Exit) => void

  constructor(private options: Options) {
    this.url = options.url ?? 'http://127.0.0.1:8765'
    this.exited = new Promise((resolve) => { this.resolveExit = resolve })
  }

  async start() {
    // Check before spawning, but still authenticate readiness to cover bind races.
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', () => reject(new Error(`Backend port ${new URL(this.url).port} is already in use. Stop the other backend and reopen OutLoud.`)))
      reservation.listen(Number(new URL(this.url).port), '127.0.0.1', () => reservation.close(() => resolve()))
    })
    await mkdir(this.options.dataDirectory, { recursive: true })
    if (this.startupCancelled) throw new Error('Desktop startup was cancelled.')
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, OUTLOUD_DESKTOP_TOKEN: this.token, OUTLOUD_DESKTOP_PARENT_STDIN: '1' }
    // Desktop data must not accidentally inherit a browser's database override.
    delete env.OUTLOUD_CONVERSATIONS_DB
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.dataDirectory, env, stdio: ['pipe', 'ignore', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000)
    })
    child.once('error', (error) => {
      this.exitError = new Error(`Could not start Python. Run bun run setup in the project folder. ${error.message}`)
    })
    child.once('close', (code, signal) => {
      this.child = null
      this.exitError ??= new Error(`Python backend exited (${signal ?? code}). ${this.stderr}`)
      this.resolveExit({ code, signal })
    })
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000)
    while (Date.now() < deadline) {
      if (this.exitError) throw this.exitError
      try {
        const response = await this.request('/desktop/status')
        if (response.ok && (await response.json()).status === 'ready') return
      } catch { /* Python may still be loading its native dependencies. */ }
      await delay(100)
    }
    await this.forceStop()
    throw new Error('Python did not become ready within two minutes. Check the Python environment and restart OutLoud.')
  }

  private request(path: string, method = 'GET') {
    return fetch(`${this.url}${path}`, {
      method,
      headers: { 'X-OutLoud-Desktop-Token': this.token },
      signal: AbortSignal.timeout(2000),
    })
  }

  async stop() {
    if (!this.child) return
    const response = await this.request('/desktop/shutdown', 'POST')
    if (response.status !== 202) throw new Error('Python did not accept shutdown. Keep waiting or explicitly force quit.')
    // No deadline: saved transcription jobs must have time to finish.
    await this.exited
  }

  async forceStop() {
    // Cancellation must outlive this call, including pre-spawn async work.
    this.startupCancelled = true
    const child = this.child
    if (!child) return
    if (child.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
          killer.once('error', reject)
          killer.once('close', (code) => code === 0 || !this.child ? resolve() : reject(new Error('Could not force quit Python.')))
        })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (error) { if (this.child) throw error }
      }
    }
    await this.exited
  }
}
