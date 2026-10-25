// Thin typed wrappers around the preload bridge for core channels.
import type { CollectionName, Collections, Settings } from '@shared/contracts'
import { CORE } from '@shared/ipc'

export const bridge = window.hangar

export const api = {
  list: <K extends CollectionName>(name: K) => bridge.invoke<Collections[K][]>(CORE.storeList, name),
  get: <K extends CollectionName>(name: K, id: string) =>
    bridge.invoke<Collections[K] | undefined>(CORE.storeGet, name, id),
  put: <K extends CollectionName>(name: K, row: Collections[K]) =>
    bridge.invoke<Collections[K]>(CORE.storePut, name, row),
  patch: <K extends CollectionName>(name: K, id: string, patch: Partial<Collections[K]>) =>
    bridge.invoke<Collections[K] | undefined>(CORE.storePatch, name, id, patch),
  remove: (name: CollectionName, id: string) => bridge.invoke<boolean>(CORE.storeDelete, name, id),
  settings: () => bridge.invoke<Settings>(CORE.settingsGet),
  patchSettings: (patch: Partial<Settings>) => bridge.invoke<Settings>(CORE.settingsPatch, patch),
  pickFolder: (defaultPath?: string) => bridge.invoke<string | undefined>(CORE.pickFolder, defaultPath),
  openExternal: (url: string) => bridge.invoke(CORE.openExternal, url),
  openPath: (path: string) => bridge.invoke(CORE.openPath, path),
  homeDir: () => bridge.invoke<string>(CORE.homeDir)
}
