// Helpers shared by every BrowserWindow the app creates (main window, Quick Entry, …),
// and the app-wide hardening of web contents (navigation, popups, webviews, permissions). See docs/SECURITY.md.

import { app, dialog, session, shell, type BrowserWindow, type WebContents, type WebPreferences } from 'electron'
import { join } from 'node:path'
import { BROWSER_PARTITION } from '../../shared/features/preview'
import { isRendererUrl } from './ipcGuard'

let quitting = false

/** True once the app is really quitting (tray "Sair", app.quit()), as opposed to a window close. */
export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

/**
 * webPreferences every renderer window uses: sandboxed renderer, context isolation, no Node, and the shared
 * preload bridge (which only uses contextBridge / ipcRenderer / webUtils, all available sandboxed).
 */
export function rendererWebPreferences(extra: WebPreferences = {}): WebPreferences {
  return {
    ...extra,
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true
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

/**
 * Opens a link outside the app: http(s) in the system browser; mailto: only after the user confirms;
 * anything else (file:, javascript:, custom protocols…) is refused.
 */
export async function openExternalLink(url: string, parent?: BrowserWindow): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    await shell.openExternal(parsed.href)
    return true
  }
  if (parsed.protocol === 'mailto:') {
    const options = {
      type: 'question' as const,
      buttons: ['Abrir', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Abrir e-mail',
      message: 'Abrir o programa de e-mail?',
      detail: decodeURIComponent(parsed.href).slice(0, 500)
    }
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response !== 0) return false
    await shell.openExternal(parsed.href)
    return true
  }
  console.warn(`[hangar] link externo recusado: ${parsed.protocol}`)
  return false
}

function isBrowsableUrl(url: string): boolean {
  return /^(https?:|about:blank)/i.test(url)
}

/** Permissions the Hangar renderer itself may use (copy buttons, full-screen Motion player). */
const RENDERER_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

function hardenWindowContents(contents: WebContents): void {
  // The app window never navigates away from the renderer; external links go to the system browser.
  const stayInApp = (event: Electron.Event, url: string) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    void openExternalLink(url)
  }
  contents.on('will-navigate', stayInApp)
  contents.on('will-redirect', stayInApp)
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalLink(url)
    return { action: 'deny' }
  })

  // Webviews (embedded browser) get a plain browser tab's powers and nothing more, in the browser partition.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.partition = BROWSER_PARTITION
    params.partition = BROWSER_PARTITION
    if (params.src && !isBrowsableUrl(params.src)) {
      console.warn(`[hangar] webview recusado: ${params.src.slice(0, 200)}`)
      event.preventDefault()
    }
  })
}

/**
 * App-wide hardening, installed once at startup (before any window exists): navigation and popups of app
 * windows, webview attachment, and a deny-by-default permission handler on the app's own session.
 */
export function installWebContentsHardening(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') hardenWindowContents(contents)
  })

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details.requestingUrl || contents?.getURL() || ''
    const allowed = RENDERER_PERMISSIONS.has(permission) && isRendererUrl(url)
    if (!allowed) console.warn(`[hangar] permissão negada: ${permission} (${url.slice(0, 120)})`)
    callback(allowed)
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (!RENDERER_PERMISSIONS.has(permission)) return false
    // Checks carry an origin; our file:// page reports "file://". Opaque-origin iframes ("null") get nothing.
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) return requestingOrigin === new URL(devUrl).origin
    return requestingOrigin === 'file://' || requestingOrigin === 'file:///'
  })
}
