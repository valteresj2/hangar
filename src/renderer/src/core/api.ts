// Typed IPC for the renderer: `bridge.invoke` / `bridge.on` only accept channels of the contract in
// src/shared/ipc.ts (extended by each src/shared/features/<feature>.ts), with its argument, result and payload
// types. `window.hangar` (the preload's untyped transport) stays the only way to main.
import type { CollectionName, Collections, Settings } from '@shared/contracts'
import {
  CORE,
  type EventChannel,
  type EventPayload,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult
} from '@shared/ipc'

const transport = window.hangar

export const bridge = {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> {
    return transport.invoke<InvokeResult<C>>(channel, ...args)
  },
  /** Subscribes to a main → renderer event; returns the unsubscribe function. */
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayload<E>) => void): () => void {
    return transport.on(channel, (...args) => listener(args[0] as EventPayload<E>))
  },
  pathForFile: (file: File): string => transport.pathForFile(file),
  platform: transport.platform
}

export const api = {
  list: <K extends CollectionName>(name: K) => bridge.invoke(CORE.storeList, name) as Promise<Collections[K][]>,
  get: <K extends CollectionName>(name: K, id: string) =>
    bridge.invoke(CORE.storeGet, name, id) as Promise<Collections[K] | undefined>,
  put: <K extends CollectionName>(name: K, row: Collections[K]) =>
    bridge.invoke(CORE.storePut, name, row) as Promise<Collections[K]>,
  patch: <K extends CollectionName>(name: K, id: string, patch: Partial<Collections[K]>) =>
    bridge.invoke(CORE.storePatch, name, id, patch) as Promise<Collections[K] | undefined>,
  remove: (name: CollectionName, id: string) => bridge.invoke(CORE.storeDelete, name, id),
  settings: (): Promise<Settings> => bridge.invoke(CORE.settingsGet),
  patchSettings: (patch: Partial<Settings>) => bridge.invoke(CORE.settingsPatch, patch),
  pickFolder: (defaultPath?: string) => bridge.invoke(CORE.pickFolder, defaultPath),
  openExternal: (url: string) => bridge.invoke(CORE.openExternal, url),
  openPath: (path: string) => bridge.invoke(CORE.openPath, path),
  homeDir: () => bridge.invoke(CORE.homeDir)
}
