export type DesktopState = {
  phase: 'starting' | 'running' | 'stopping' | 'closed' | 'error'
  message: string
}
