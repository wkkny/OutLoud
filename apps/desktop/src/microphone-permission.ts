export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'unavailable' | 'system-managed'
type PermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
type NativePermissions = {
  platform: NodeJS.Platform
  getStatus: () => PermissionStatus
  request: () => Promise<boolean>
  openExternal: (url: string) => Promise<void>
}

/** Gate capture on native consent without opening a second audio stream. */
export class MicrophonePermission {
  private pending: Promise<MicrophoneAccess> | null = null
  constructor(private native: NativePermissions) {}

  request(): Promise<MicrophoneAccess> {
    this.pending ??= this.check().finally(() => { this.pending = null })
    return this.pending
  }

  async openSettings(): Promise<void> {
    const target = this.native.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      : this.native.platform === 'win32' ? 'ms-settings:privacy-microphone' : null
    if (!target) throw new Error('Open your system’s microphone settings manually.')
    await this.native.openExternal(target)
  }

  private async check(): Promise<MicrophoneAccess> {
    if (this.native.platform !== 'darwin' && this.native.platform !== 'win32') return 'system-managed'
    try {
      const status = this.native.getStatus()
      if (status === 'granted' || status === 'denied' || status === 'restricted') return status
      if (this.native.platform === 'darwin' && status === 'not-determined') {
        return await this.native.request() ? 'granted' : 'denied'
      }
      return 'unavailable'
    } catch { return 'unavailable' }
  }
}
