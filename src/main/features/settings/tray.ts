// System notifications for session events, the tray icon and the app icon.

import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, type NativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeatureContext } from '../../core/feature'
import { bus } from '../../core/bus'
import { db, settings } from '../../core/store'
import { isQuitting, markQuitting } from '../../core/window'
import { SETTINGS } from '../../../shared/features/settings'
import { closeQuickEntry, toggleQuickEntry } from './quickEntry'

let tray: Tray | undefined
// Keep notifications referenced until dismissed, otherwise their click handlers can be GC'd on Windows.
const live = new Set<Notification>()

function showWindow(ctx: FeatureContext): BrowserWindow {
  return ctx.showMainWindow()
}

/**
 * Shows the main window and sends `channel` to it once its renderer is ready
 * (the window may have just been recreated, in which case nothing listens yet).
 */
export function showMainAndSend(ctx: FeatureContext, channel: string, payload?: unknown): void {
  const win = showWindow(ctx)
  const send = () => !win.isDestroyed() && win.webContents.send(channel, payload)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 400))
  else send()
}

function windowFocused(ctx: FeatureContext): boolean {
  const win = ctx.mainWindow()
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused()
}

export function showNotification(ctx: FeatureContext, title: string, body: string, sessionId?: string): boolean {
  if (!Notification.isSupported()) return false
  const n = new Notification({ title, body, icon: appIcon() })
  live.add(n)
  const release = () => live.delete(n)
  n.on('click', () => {
    release()
    if (sessionId) showMainAndSend(ctx, SETTINGS.focusSession, { sessionId })
    else showWindow(ctx)
  })
  n.on('close', release)
  n.on('failed', release)
  n.show()
  return true
}

function notifySession(ctx: FeatureContext, sessionId: string, kind: 'ended' | 'error' | 'permission' | 'question'): void {
  if (!settings().get().notifications || windowFocused(ctx)) return
  const title = db('sessions').get(sessionId)?.title ?? 'Sessão'
  const text = {
    ended: [`${title} terminou`, 'A sessão concluiu a tarefa.'],
    error: [`${title} terminou`, 'A sessão terminou com erro.'],
    permission: [`${title} precisa de você`, 'Há um pedido de permissão aguardando.'],
    question: [`${title} precisa de você`, 'O Claude fez uma pergunta.']
  }[kind]
  showNotification(ctx, text[0], text[1], sessionId)
}

/** Draws the tray icon (accent rounded square with a white "H") as a BGRA bitmap. */
function drawIcon(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const radius = size * 0.22
  const inH = (u: number, v: number) =>
    v >= 0.24 && v <= 0.76 && ((u >= 0.27 && u <= 0.41) || (u >= 0.59 && u <= 0.73) || (v >= 0.44 && v <= 0.56 && u >= 0.27 && u <= 0.73))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const dx = Math.max(radius - cx, 0, cx - (size - radius))
      const dy = Math.max(radius - cy, 0, cy - (size - radius))
      const alpha = Math.min(Math.max(radius + 0.5 - Math.hypot(dx, dy), 0), 1)
      const [r, g, b] = inH(cx / size, cy / size) ? [255, 255, 255] : [0xc9, 0x64, 0x42]
      const i = (y * size + x) * 4
      // Premultiplied BGRA.
      buf[i] = Math.round(b * alpha)
      buf[i + 1] = Math.round(g * alpha)
      buf[i + 2] = Math.round(r * alpha)
      buf[i + 3] = Math.round(255 * alpha)
    }
  }
  return buf
}

function iconImage(base: number, scales: number[]): NativeImage {
  const img = nativeImage.createFromBitmap(drawIcon(base), { width: base, height: base, scaleFactor: 1 })
  for (const scale of scales) {
    const size = Math.round(base * scale)
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: drawIcon(size) })
  }
  return img
}

let trayIcon: NativeImage | undefined
let windowIcon: NativeImage | undefined

/** Tray-sized icon (16 px plus HiDPI representations). */
function trayImage(): NativeImage {
  return (trayIcon ??= iconImage(16, [1.25, 1.5, 2]))
}

/** App icon for windows, the taskbar and notifications (32 px base up to 256 px). */
export function appIcon(): NativeImage {
  return (windowIcon ??= iconImage(32, [1.5, 2, 4, 8]))
}

// ---- "Still running in the tray" notice, shown once ----

function stateFile(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'settings')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'state.json')
}

function readState(): { trayNoticeShown?: boolean } {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as { trayNoticeShown?: boolean }
  } catch {
    return {}
  }
}

function onMainWindowHidden(ctx: FeatureContext): void {
  if (isQuitting() || !settings().get().minimizeToTray) return
  const state = readState()
  if (state.trayNoticeShown) return
  writeFileSync(stateFile(), JSON.stringify({ ...state, trayNoticeShown: true }, null, 2), 'utf8')
  showNotification(ctx, 'O Hangar continua rodando', 'Ele fica na bandeja do sistema. Use "Sair" no menu do ícone para encerrar.')
}

/** Hooks the main window (created later by the core, and possibly recreated) for the tray notice and cleanup. */
function watchMainWindow(ctx: FeatureContext): () => void {
  const onCreated = (_e: Electron.Event, win: BrowserWindow) => {
    // The core assigns its main window right after the constructor returns.
    setImmediate(() => {
      if (win.isDestroyed() || ctx.mainWindow() !== win) return
      win.on('hide', () => onMainWindowHidden(ctx))
      // A hidden Quick Entry window would keep 'window-all-closed' from firing when the app should quit.
      win.on('closed', () => {
        if (!settings().get().minimizeToTray) closeQuickEntry()
      })
    })
  }
  app.on('browser-window-created', onCreated)
  return () => app.off('browser-window-created', onCreated)
}

function toggleMainWindow(ctx: FeatureContext): void {
  const win = ctx.mainWindow()
  if (win && win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow(ctx)
}

const onTurnEnded = (ctx: FeatureContext) => (e: { sessionId: string; result: 'success' | 'error' }) =>
  notifySession(ctx, e.sessionId, e.result === 'error' ? 'error' : 'ended')
const onNeedsInput = (ctx: FeatureContext) => (e: { sessionId: string; reason: 'permission' | 'question' }) =>
  notifySession(ctx, e.sessionId, e.reason === 'question' ? 'question' : 'permission')

let unsubscribe: (() => void) | undefined

export function startTrayAndNotifications(ctx: FeatureContext): void {
  const ended = onTurnEnded(ctx)
  const needs = onNeedsInput(ctx)
  bus.on('session:turn-ended', ended)
  bus.on('session:needs-input', needs)
  const unwatch = watchMainWindow(ctx)
  unsubscribe = () => {
    bus.off('session:turn-ended', ended)
    bus.off('session:needs-input', needs)
    unwatch()
  }

  tray = new Tray(trayImage())
  tray.setToolTip('Hangar')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar Hangar', click: () => showWindow(ctx) },
      { label: 'Quick Entry', click: () => toggleQuickEntry() },
      { label: 'Nova sessão', click: () => showMainAndSend(ctx, SETTINGS.newSession) },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => toggleMainWindow(ctx))
}

export function stopTrayAndNotifications(): void {
  unsubscribe?.()
  tray?.destroy()
  tray = undefined
  live.clear()
}
