import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { registerCoreIpc } from './core/ipc'
import type { FeatureContext } from './core/feature'
import { flushAll, settings } from './core/store'
import { features } from './features'

let mainWindow: BrowserWindow | undefined

const ctx: FeatureContext = { mainWindow: () => mainWindow }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Hangar',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a19' : '#faf9f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = undefined))

  // Links clicked in the app open in the system browser, never in a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setAppUserModelId('dev.hangar.app')

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  flushAll()
  for (const feature of features) await feature.dispose?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
