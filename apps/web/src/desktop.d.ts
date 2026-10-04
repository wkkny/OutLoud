export {}

declare global {
  interface Window {
    readonly outloudDesktop?: {
      readonly managedBackend: true
    }
  }
}
