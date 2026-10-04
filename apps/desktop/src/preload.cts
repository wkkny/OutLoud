import electron = require('electron')
import type { DesktopState } from './desktop-state.js'
const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('outloudDesktop', {
  managedBackend: true,
  requestMicrophoneAccess: () => ipcRenderer.invoke('desktop:microphone-permission'),
  openMicrophoneSettings: () => ipcRenderer.invoke('desktop:microphone-settings'),
  getState: () => ipcRenderer.invoke('desktop:state'),
  onState: (callback: (state: DesktopState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopState) => callback(state)
    ipcRenderer.on('desktop:state', listener)
    return () => ipcRenderer.removeListener('desktop:state', listener)
  },
  forceQuit: () => ipcRenderer.invoke('desktop:force-quit'),
})
