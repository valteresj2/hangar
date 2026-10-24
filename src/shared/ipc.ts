// IPC conventions.
//
// Request/response:  `${feature}:${action}`        e.g. `terminal:create`
// Main -> renderer:   `${feature}:event:${name}`   e.g. `terminal:event:data`
//
// Each feature declares its channels in src/shared/features/<feature>.ts so both
// sides import the same names and payload types.

export const CORE = {
  storeList: 'store:list',
  storeGet: 'store:get',
  storePut: 'store:put',
  storePatch: 'store:patch',
  storeDelete: 'store:delete',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  storeChanged: 'store:event:changed',
  pickFolder: 'app:pickFolder',
  openExternal: 'app:openExternal',
  openPath: 'app:openPath',
  homeDir: 'app:homeDir'
} as const

export interface HangarBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: any[]) => void): () => void
  pathForFile(file: File): string
  platform: string
}
