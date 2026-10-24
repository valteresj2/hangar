// Hardening for the embedded browser (<webview> tabs in the BrowserPanel).
// - Webviews get no preload / node integration, and may only load http(s) / about: pages.
// - Popups never create windows: the renderer opens them as a new internal tab.
// - Sensitive permissions (camera, mic, geolocation, ...) are denied in the browser partition.
// - Downloads always go through a "save as" dialog, never silently.

import { app, session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { broadcast } from '../../core/broadcast'
import { BROWSER_PARTITION, PREVIEW, type DownloadEvent, type PopupEvent } from '../../../shared/features/preview'

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

function isBrowsableUrl(url: string): boolean {
  return /^(https?:|about:blank)/i.test(url)
}

function hardenWebview(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isBrowsableUrl(url)) broadcast(PREVIEW.popupEvent, { sourceId: contents.id, url } satisfies PopupEvent)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isBrowsableUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isBrowsableUrl(url)) event.preventDefault()
  })
}

function onWebContentsCreated(_event: Electron.Event, contents: WebContents): void {
  if (contents.getType() === 'webview') {
    hardenWebview(contents)
    return
  }
  // Host side: strip anything that would give a guest page more power than a normal browser tab.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (params.src && !isBrowsableUrl(params.src)) event.preventDefault()
  })
}

export function setupBrowser(): void {
  app.on('web-contents-created', onWebContentsCreated)

  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

  ses.on('will-download', (_event, item) => {
    // No setSavePath(): Electron then asks the user where to save (cancel aborts the download).
    item.setSaveDialogOptions({
      title: 'Salvar download',
      defaultPath: join(app.getPath('downloads'), item.getFilename())
    })
    const id = randomUUID()
    const emit = (state: DownloadEvent['state']) =>
      broadcast(PREVIEW.downloadEvent, { id, filename: item.getFilename(), state, savePath: item.getSavePath() || undefined } satisfies DownloadEvent)
    emit('started')
    item.once('done', (_e, state) => emit(state))
  })
}

export function disposeBrowser(): void {
  app.removeListener('web-contents-created', onWebContentsCreated)
}
