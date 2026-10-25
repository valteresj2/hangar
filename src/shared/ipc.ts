// IPC conventions and the typed contract between main and renderer.
//
// Request/response:  `${feature}:${action}`        e.g. `terminal:create`
// Main -> renderer:   `${feature}:event:${name}`   e.g. `terminal:event:data`
//
// Each feature declares its channel names in src/shared/features/<feature>.ts and adds their signatures to the
// two contracts below by declaration merging:
//
//   declare module '../ipc' {
//     interface IpcInvokeContract { [GIT.status]: (cwd: string) => GitStatus }
//     interface IpcEventContract { [GIT.changed]: GitChangedEvent }
//   }
//
// Main registers handlers with `handle()` (src/main/core/handle.ts) and sends events with `broadcast()`/`sendTo()`;
// the renderer calls `bridge.invoke()` / `bridge.on()` (src/renderer/src/core/api.ts). All of them only accept
// channels of the contract with matching arguments, results and payloads, so changing a signature on one side
// without the other breaks the typecheck.
import type { CollectionName, Collections, Settings, StoreChange } from './contracts'

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

type Row = Collections[CollectionName]

/** Request/response channels: channel → (renderer arguments) => result (the handler may return it as a Promise). */
export interface IpcInvokeContract {
  [CORE.storeList]: (name: CollectionName) => Row[]
  [CORE.storeGet]: (name: CollectionName, id: string) => Row | undefined
  [CORE.storePut]: (name: CollectionName, row: Row) => Row
  [CORE.storePatch]: (name: CollectionName, id: string, patch: Partial<Row>) => Row | undefined
  [CORE.storeDelete]: (name: CollectionName, id: string) => boolean
  [CORE.settingsGet]: () => Settings
  [CORE.settingsPatch]: (patch: Partial<Settings>) => Settings
  [CORE.pickFolder]: (defaultPath?: string) => string | undefined
  [CORE.openExternal]: (url: string) => boolean
  /** Resolves to an error message, or '' on success (shell.openPath). */
  [CORE.openPath]: (path: string) => string
  [CORE.homeDir]: () => string
}

/** Main → renderer events: channel → payload (`void` for events without one). */
export interface IpcEventContract {
  [CORE.storeChanged]: StoreChange
}

export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<C extends InvokeChannel> = Parameters<IpcInvokeContract[C]>
export type InvokeResult<C extends InvokeChannel> = Awaited<ReturnType<IpcInvokeContract[C]>>

export type EventChannel = keyof IpcEventContract
export type EventPayload<E extends EventChannel> = IpcEventContract[E]
/** Arguments after the channel when sending an event: nothing for `void` events, else the payload. */
export type EventArgs<E extends EventChannel> = [IpcEventContract[E]] extends [void]
  ? []
  : [payload: IpcEventContract[E]]

/**
 * The raw transport exposed by the preload as `window.hangar`. Untyped on purpose: use the typed `bridge`
 * from src/renderer/src/core/api.ts instead of calling it directly.
 */
export interface HangarBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): () => void
  pathForFile(file: File): string
  platform: string
}
