import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { registerCoreIpc } from './core/ipc'
import type { FeatureContext } from './core/feature'
import { flushAll, settings } from './core/store'
import { isQuitting, loadRenderer, markQuitting, rendererWebPreferences } from './core/window'
import { features } from './features'
import { appIcon } from './features/settings/tray'

let mainWindow: BrowserWindow | undefined

const ctx: FeatureContext = {
  mainWindow: () => mainWindow,
  showMainWindow: () => {
    const win = mainWindow ?? createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Hangar',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a19' : '#faf9f5',
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: rendererWebPreferences({ webviewTag: true })
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })

  // With "minimize to tray" on, closing the window only hides it; the tray menu's "Sair" quits.
  win.on('close', (event) => {
    if (!isQuitting() && settings().get().minimizeToTray) {
      event.preventDefault()
      win.hide()
    }
  })

  // Links clicked in the app open in the system browser, never in a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  void loadRenderer(win)
  return win
}

app.setAppUserModelId('dev.hangar.app')

// A second launch focuses the running instance instead of opening another one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => ctx.showMainWindow())
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = settings().get().theme
  registerCoreIpc(ctx)
  for (const feature of features) {
    try {
      await feature.register(ctx)
    } catch (err) {
      console.error(`[hangar] feature "${feature.name}" failed to register`, err)
    }
  }
  createWindow()
  app.on('activate', () => ctx.showMainWindow())
})

app.on('before-quit', async () => {
  markQuitting()
  flushAll()
  for (const feature of features) await feature.dispose?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !settings().get().minimizeToTray) app.quit()
})
