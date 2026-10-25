// Typed IPC registration for main: only channels of the contract (src/shared/ipc.ts), with the contract's
// argument and result types. Goes through ipcMain.handle, so the IPC guard (ipcGuard.ts) still checks every sender.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { EventArgs, EventChannel, InvokeArgs, InvokeChannel, InvokeResult } from '../../shared/ipc'

/** A handler for `C`: receives the invoke event and the contract's arguments, returns its result (or a Promise). */
export type Handler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeArgs<C>
) => InvokeResult<C> | Promise<InvokeResult<C>>

export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  // The renderer's arguments arrive untyped; the contract is what both sides agreed to send.
  ipcMain.handle(channel, (event, ...args) => handler(event, ...(args as InvokeArgs<C>)))
}

/** Sends an event of the contract to one renderer. */
export function sendTo<E extends EventChannel>(contents: WebContents, channel: E, ...args: EventArgs<E>): void {
  if (!contents.isDestroyed()) contents.send(channel, ...args)
}
