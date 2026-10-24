import { app, BrowserWindow, nativeTheme } from 'electron'
import { installIpcGuard } from './core/ipcGuard'
import { registerCoreIpc } from './core/ipc'
import type { FeatureContext } from './core/feature'
import { flushAll, settings } from './core/store'
import { installWebContentsHardening, isQuitting, loadRenderer, markQuitting, rendererWebPreferences } from './core/window'
import { features } from './features'
import { providersReady } from './features/settings/providers'
import { appIcon } from './features/settings/tray'

// Before anything registers a handler: IPC only answers the Hangar renderer (see core/ipcGuard.ts).
installIpcGuard()

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

  // Navigation, popups (links open in the system browser) and webviews are locked down app-wide
  // in installWebContentsHardening (core/window.ts).

  void loadRenderer(win)
  return win
}

app.setAppUserModelId('dev.hangar.app')

// Launched from inside a Claude Code session (dev runs, agents), Hangar would pass that session's host variables
// on to every Claude Code it starts, and the child CLI would reuse the host's auth and ignore provider profiles.
if (process.env['CLAUDECODE']) {
  for (const key of Object.keys(process.env)) {
    if (
      key === 'CLAUDECODE' ||
      // The host session points this at its own endpoint; the installed app would follow ~/.claude/settings.json.
      key === 'ANTHROPIC_BASE_URL' ||
      /^CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SSE_PORT|SDK_HAS_HOST_AUTH_REFRESH|OAUTH_SCOPES|MESSAGING_.+)$/.test(key) ||
      key.startsWith('CLAUDE_AGENT_SDK_')
    ) {
      delete process.env[key]
    }
  }
}

// A second launch focuses the running instance instead of opening another one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => ctx.showMainWindow())
}

app.whenReady().then(async () => {
  installWebContentsHardening()
  nativeTheme.themeSource = settings().get().theme
  registerCoreIpc(ctx)
  for (const feature of features) {
    try {
      await feature.register(ctx)
    } catch (err) {
      console.error(`[hangar] feature "${feature.name}" failed to register`, err)
    }
  }
  // Provider secrets are decrypted asynchronously (safeStorage); no window (so no session) opens before that.
  await providersReady()
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
