import type { DesktopState } from './desktop-state.js'
declare const window: Window & {
  outloudDesktop: {
    getState(): Promise<DesktopState>
    onState(callback: (state: DesktopState) => void): () => void
    forceQuit(): Promise<void>
  }
}

const title = document.querySelector<HTMLHeadingElement>('#title')!
const message = document.querySelector<HTMLParagraphElement>('#message')!
const hint = document.querySelector<HTMLParagraphElement>('#hint')!
const force = document.querySelector<HTMLButtonElement>('#force')!
function render(state: DesktopState) {
  title.textContent = state.phase === 'stopping' ? 'Finishing transcription…' : state.phase === 'error' ? 'OutLoud could not start' : 'Starting OutLoud…'
  message.textContent = state.message
  force.hidden = state.phase !== 'stopping'
  hint.textContent = state.phase === 'stopping'
    ? 'Recording is stopping. OutLoud will close when saved transcription jobs finish. Force quit requires confirmation and may lose unfinished transcription.'
    : state.phase === 'error' ? 'Close this window, resolve the issue, and reopen OutLoud. Existing saved conversations are retained.'
    : 'Your conversations and recordings stay on this computer.'
}
window.outloudDesktop.onState(render)
void window.outloudDesktop.getState().then(render)
force.addEventListener('click', async () => {
  force.disabled = true
  try { await window.outloudDesktop.forceQuit() }
  finally { force.disabled = false }
})
