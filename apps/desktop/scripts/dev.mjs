import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { startUi } from './ui-server.mjs'

const require = createRequire(import.meta.url)
const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const build = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', desktopRoot], { stdio: 'inherit' })
const built = await new Promise((resolve, reject) => {
  build.once('error', reject)
  build.once('exit', resolve)
})
if (built !== 0) process.exit(1)

let ui
try { ui = await startUi() }
catch (error) {
  console.error('Could not start the desktop UI. Stop any existing Vite server on port 5174.', error.message)
  process.exit(1)
}
const env = { ...process.env, OUTLOUD_DESKTOP_LAUNCHER: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [desktopRoot], { env, stdio: ['pipe', 'inherit', 'inherit'] })
const quit = () => {
  console.log('Closing OutLoud gracefully. Use Force quit in its window if transcription is stuck.')
  if (!child.stdin.destroyed) child.stdin.write('quit\n')
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
child.stdin.on('error', () => {}) // A normal quit can close the pipe first.
child.once('error', async (error) => { console.error(error); await ui.close(); process.exitCode = 1 })
child.once('close', async (code) => { await ui.close(); process.exitCode = code ?? 1 })
console.log('OutLoud desktop is starting. Close its window or press Ctrl+C to stop.')
