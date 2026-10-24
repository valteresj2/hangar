// IPC guard: every ipcMain handler only answers the Hangar renderer itself — the top frame of one of our
// BrowserWindows showing our own renderer URL (the built index.html, or ELECTRON_RENDERER_URL in dev).
// Webviews (embedded browser), iframes (artifacts) and windows that navigated elsewhere are refused and logged.
//
// Installed once, before core or any feature registers a handler, by wrapping ipcMain.handle / handleOnce /
// on / once; features keep calling ipcMain as usual.

import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent

let installed = false

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True for our renderer's own page (any hash/query, e.g. `#quick-entry`). */
export function isRendererUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return parsed.origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  if (parsed.protocol !== 'file:') return false
  parsed.hash = ''
  parsed.search = ''
  try {
    return normalizePath(fileURLToPath(parsed)) === normalizePath(join(__dirname, '../renderer/index.html'))
  } catch {
    return false
  }
}

/** The sender is the top frame of a Hangar window showing the renderer. */
export function isTrustedSender(event: AnyEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent) return false
  const contents = event.sender
  if (contents.isDestroyed() || contents.getType() !== 'window' || !BrowserWindow.fromWebContents(contents)) return false
  return isRendererUrl(frame.url)
}

const logged = new Set<string>()

function refuse(channel: string, event: AnyEvent): void {
  const type = event.sender.isDestroyed() ? 'destroyed' : event.sender.getType()
  const url = (event.senderFrame?.url ?? '?').slice(0, 200)
  const key = `${channel}|${type}|${url}`
  if (logged.has(key)) return
  if (logged.size > 500) logged.clear()
  logged.add(key)
  console.warn(`[hangar] IPC recusado: "${channel}" de ${type}${event.senderFrame?.parent ? ' (subframe)' : ''} em ${url}`)
}

/** Wraps ipcMain so every handler checks its sender. Call before anything registers IPC. */
export function installIpcGuard(): void {
  if (installed) return
  installed = true

  const handle = ipcMain.handle.bind(ipcMain)
  const handleOnce = ipcMain.handleOnce.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  const once = ipcMain.once.bind(ipcMain)
  const removeListener = ipcMain.removeListener.bind(ipcMain)
  // Original listener → guarded wrapper, so removeListener/off keep working.
  const wrappers = new WeakMap<(...args: any[]) => void, (...args: any[]) => void>()

  type Invoke = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  type Listener = (event: IpcMainEvent, ...args: any[]) => void

  const guardInvoke = (channel: string, listener: Invoke): Invoke => (event, ...args) => {
    if (!isTrustedSender(event)) {
      refuse(channel, event)
      throw new Error(`IPC recusado: "${channel}" só atende a janela do Hangar.`)
    }
    return listener(event, ...args)
  }
  const guardListener = (channel: string, listener: Listener): Listener => {
    const wrapped: Listener = (event, ...args) => {
      if (!isTrustedSender(event)) return refuse(channel, event)
      listener(event, ...args)
    }
    wrappers.set(listener, wrapped)
    return wrapped
  }

  ipcMain.handle = ((channel: string, listener: Invoke) => handle(channel, guardInvoke(channel, listener))) as typeof ipcMain.handle
  ipcMain.handleOnce = ((channel: string, listener: Invoke) =>
    handleOnce(channel, guardInvoke(channel, listener))) as typeof ipcMain.handleOnce
  ipcMain.on = ((channel: string, listener: Listener) => on(channel, guardListener(channel, listener))) as typeof ipcMain.on
  ipcMain.once = ((channel: string, listener: Listener) => once(channel, guardListener(channel, listener))) as typeof ipcMain.once
  const remove = ((channel: string, listener: Listener) =>
    removeListener(channel, (wrappers.get(listener) as Listener | undefined) ?? listener)) as typeof ipcMain.removeListener
  ipcMain.removeListener = remove
  ipcMain.off = remove
}
