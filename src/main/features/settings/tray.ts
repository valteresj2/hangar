// System notifications for session events and the tray icon.

import { app, Menu, nativeImage, Notification, Tray, type NativeImage } from 'electron'
import type { FeatureContext } from '../../core/feature'
import { broadcast } from '../../core/broadcast'
import { bus } from '../../core/bus'
import { db, settings } from '../../core/store'
import { SETTINGS } from '../../../shared/features/settings'

let tray: Tray | undefined
// Keep notifications referenced until dismissed, otherwise their click handlers can be GC'd on Windows.
const live = new Set<Notification>()

function showWindow(ctx: FeatureContext): void {
  const win = ctx.mainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function windowFocused(ctx: FeatureContext): boolean {
  const win = ctx.mainWindow()
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused()
}

export function showNotification(ctx: FeatureContext, title: string, body: string, sessionId?: string): boolean {
  if (!Notification.isSupported()) return false
  const n = new Notification({ title, body, icon: trayImage() })
  live.add(n)
  const release = () => live.delete(n)
  n.on('click', () => {
    release()
    showWindow(ctx)
    if (sessionId) broadcast(SETTINGS.focusSession, { sessionId })
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

let image: NativeImage | undefined
function trayImage(): NativeImage {
  if (image) return image
  image = nativeImage.createFromBitmap(drawIcon(16), { width: 16, height: 16, scaleFactor: 1 })
  for (const scale of [1.5, 2]) {
    const size = Math.round(16 * scale)
    image.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: drawIcon(size) })
  }
  return image
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
  unsubscribe = () => {
    bus.off('session:turn-ended', ended)
    bus.off('session:needs-input', needs)
  }

  tray = new Tray(trayImage())
  tray.setToolTip('Hangar')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar Hangar', click: () => showWindow(ctx) },
      {
        label: 'Nova sessão',
        click: () => {
          showWindow(ctx)
          broadcast(SETTINGS.newSession)
        }
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ])
  )
  tray.on('click', () => showWindow(ctx))
}

export function stopTrayAndNotifications(): void {
  unsubscribe?.()
  tray?.destroy()
  tray = undefined
  live.clear()
}
