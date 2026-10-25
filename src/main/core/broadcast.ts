import { BrowserWindow } from 'electron'
import type { EventArgs, EventChannel } from '../../shared/ipc'

/** Send an event of the IPC contract (src/shared/ipc.ts) to every open renderer window. */
export function broadcast<E extends EventChannel>(channel: E, ...args: EventArgs<E>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}
