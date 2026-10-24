// Helpers shared by every BrowserWindow the app creates (main window, Quick Entry, …).

import type { BrowserWindow, WebPreferences } from 'electron'
import { join } from 'node:path'

let quitting = false

/** True once the app is really quitting (tray "Sair", app.quit()), as opposed to a window close. */
export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

/** webPreferences every renderer window uses (shared preload bridge). */
export function rendererWebPreferences(extra: WebPreferences = {}): WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true,
    ...extra
  }
}

/**
 * Loads the renderer into a window. `hash` selects an alternate root view
 * (see src/renderer/src/main.tsx), e.g. 'quick-entry'.
 */
export function loadRenderer(win: BrowserWindow, hash?: string): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}
