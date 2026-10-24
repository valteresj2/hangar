// Preload of every Hangar window. Runs sandboxed (webPreferences.sandbox: true): only the sandbox-safe Electron
// modules (contextBridge, ipcRenderer, webUtils) and `process.platform` are available here; no Node APIs.
// The bridge it exposes is answered by main only for our own top frame (src/main/core/ipcGuard.ts).
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HangarBridge } from '../shared/ipc'

const bridge: HangarBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('hangar', bridge)
