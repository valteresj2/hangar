import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import { installIpcGuard } from './core/ipcGuard'
import { registerCoreIpc } from './core/ipc'
import type { FeatureContext } from './core/feature'
import { flushAll, settings } from './core/store'
import {
  installWebContentsHardening,
  isQuitting,
  loadRenderer,
  markQuitting,
  rendererWebPreferences
} from './core/window'
import { features } from './features'
import { providersReady } from './features/settings/providers'
import { appIcon } from './features/settings/tray'
import { deepLinkFromArgv, handleDeepLink, registerProtocol } from './features/workspace/api'

// The installed app was called "Hangar" before it became "Agent Hangar Desktop": keep its data folder (sessions,
// settings, encrypted keys) instead of following the new product name. Before anything reads userData (the
// single-instance lock included). Tests and dev runs pass --user-data-dir or use the package name and are left alone.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'Hangar'))
}

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
    title: BRAND.productName,
    show: false,
    // The splash (src/renderer/index.html) and the title bar are tarmac in both themes.
    backgroundColor: '#1c2530',
    autoHideMenuBar: true,
    icon: appIcon(),
    // Our own title bar (src/renderer/src/shell/TitleBar.tsx): the native controls stay, drawn over it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 11 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#1c2530', symbolColor: '#c9d1db', height: BRAND.titleBarHeight }
        }),
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

// A second launch focuses the running instance instead of opening another one. On Windows/Linux a `hangar://`
// link opened while the app runs arrives here, in the second launch's arguments.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerProtocol()
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv)
    if (!link || !handleDeepLink(link)) ctx.showMainWindow()
  })
}

// macOS delivers `hangar://` links as open-url (also before 'ready': the workspace feature keeps them).
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

void app.whenReady().then(async () => {
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
  // Launched by a `hangar://` link (Windows/Linux): the new window opens on that screen.
  const link = deepLinkFromArgv(process.argv)
  if (link) handleDeepLink(link)
  app.on('activate', () => ctx.showMainWindow())
})

app.on('before-quit', () => {
  markQuitting()
  flushAll()
  void (async () => {
    for (const feature of features) await feature.dispose?.()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !settings().get().minimizeToTray) app.quit()
})
