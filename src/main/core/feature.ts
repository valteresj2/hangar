import type { BrowserWindow } from 'electron'

export interface FeatureContext {
  /** Returns the main window (may be undefined before creation / after close). */
  mainWindow(): BrowserWindow | undefined
}

export interface Feature {
  name: string
  /** Register ipcMain handlers and start background work. Called once after app 'ready'. */
  register(ctx: FeatureContext): void | Promise<void>
  /** Clean up child processes etc. Called on 'before-quit'. */
  dispose?(): void | Promise<void>
}
