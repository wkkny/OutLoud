export {}

declare global {
  interface Window {
    readonly outloudDesktop?: {
      readonly managedBackend: true
      requestMicrophoneAccess: () => Promise<'granted' | 'denied' | 'restricted' | 'unavailable' | 'system-managed'>
      openMicrophoneSettings: () => Promise<void>
    }
  }
}
