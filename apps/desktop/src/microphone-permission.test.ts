import { expect, it, vi } from 'vitest'
import { MicrophonePermission } from './microphone-permission.js'

it('requests macOS consent only on explicit user intent and coalesces pending requests', async () => {
  let grant: ((allowed: boolean) => void) | undefined
  const request = vi.fn<() => Promise<boolean>>(() => new Promise((resolve) => { grant = resolve }))
  const getStatus = vi.fn<() => 'not-determined'>().mockReturnValue('not-determined')
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus, request, openExternal: vi.fn() })
  expect(request).not.toHaveBeenCalled()
  const first = permission.request()
  const second = permission.request()
  expect(request).toHaveBeenCalledOnce()
  grant!(true)
  await expect(first).resolves.toBe('granted')
  await expect(second).resolves.toBe('granted')
})

it('does not re-prompt denied access and opens only the fixed microphone settings target', async () => {
  const getStatus = vi.fn<() => 'denied' | 'granted'>().mockReturnValue('denied')
  const request = vi.fn()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus, request, openExternal })
  await expect(permission.request()).resolves.toBe('denied')
  expect(request).not.toHaveBeenCalled()
  await permission.openSettings()
  expect(openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  getStatus.mockReturnValue('granted')
  await expect(permission.request()).resolves.toBe('granted')
  expect(request).not.toHaveBeenCalled()
})

it('uses Windows permission status and privacy settings without calling the macOS prompt', async () => {
  const request = vi.fn()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const permission = new MicrophonePermission({ platform: 'win32', getStatus: () => 'denied', request, openExternal })
  await expect(permission.request()).resolves.toBe('denied')
  await permission.openSettings()
  expect(openExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone')
  expect(request).not.toHaveBeenCalled()
})

it('leaves Linux capture to the system without using unsupported native permission APIs', async () => {
  const getStatus = vi.fn(() => { throw new Error('Unsupported') })
  const request = vi.fn()
  const openExternal = vi.fn()
  const permission = new MicrophonePermission({ platform: 'linux', getStatus, request, openExternal })
  await expect(permission.request()).resolves.toBe('system-managed')
  await expect(permission.openSettings()).rejects.toThrow('Open your system’s microphone settings manually.')
  expect(getStatus).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
})

it.each([
  { status: 'granted', access: 'granted' },
  { status: 'restricted', access: 'restricted' },
  { status: 'unknown', access: 'unavailable' },
] as const)('uses native status $status without prompting', async ({ status, access }) => {
  const request = vi.fn()
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus: () => status, request, openExternal: vi.fn() })
  await expect(permission.request()).resolves.toBe(access)
  expect(request).not.toHaveBeenCalled()
})

it('reports a declined first prompt without recording consent', async () => {
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus: () => 'not-determined', request: async () => false, openExternal: vi.fn() })
  await expect(permission.request()).resolves.toBe('denied')
})

it('recovers from a failed native request rather than caching failure forever', async () => {
  const request = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('Native error')).mockResolvedValueOnce(true)
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus: () => 'not-determined', request, openExternal: vi.fn() })
  await expect(permission.request()).resolves.toBe('unavailable')
  await expect(permission.request()).resolves.toBe('granted')
})

it('does not prompt or claim permission when querying native status fails', async () => {
  const request = vi.fn()
  const permission = new MicrophonePermission({ platform: 'darwin', getStatus: () => { throw new Error('Native error') }, request, openExternal: vi.fn() })
  await expect(permission.request()).resolves.toBe('unavailable')
  expect(request).not.toHaveBeenCalled()
})
