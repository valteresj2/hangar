// Quick Entry: a global shortcut that opens a small frameless window to start a session
// from anywhere. The window is created once and hidden (not destroyed) between uses.

import { BrowserWindow, dialog, globalShortcut, nativeTheme, screen } from 'electron'
import { SETTINGS, type QuickEntryStatus } from '../../../shared/features/settings'
import { broadcast } from '../../core/broadcast'
import { sendTo } from '../../core/handle'
import { settings } from '../../core/store'
import { isQuitting, loadRenderer, rendererWebPreferences } from '../../core/window'

const WIDTH = 680
const HEIGHT = 250

let win: BrowserWindow | undefined
// True while a native dialog owned by the window is open, so losing focus to it doesn't hide the window.
let ignoreBlur = false
let registered: string | undefined
let suspended = false
let status: QuickEntryStatus = { accelerator: '', registered: false, suspended: false }

const background = () => (nativeTheme.shouldUseDarkColors ? '#242423' : '#ffffff')

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    title: 'Quick Entry',
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: background(),
    webPreferences: rendererWebPreferences()
  })
  w.on('blur', () => {
    if (!ignoreBlur) w.hide()
  })
  // Alt+F4 only hides; the window is destroyed when the app quits.
  w.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      w.hide()
    }
  })
  w.on('closed', () => {
    if (win === w) win = undefined
  })
  void loadRenderer(w, 'quick-entry')
  return w
}

export function showQuickEntry(): void {
  const w = (win ??= createWindow())
  // Center horizontally on the display under the cursor, a bit above the middle.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  w.setBounds({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height * 0.28),
    width: WIDTH,
    height: HEIGHT
  })
  w.setBackgroundColor(background())
  const reveal = () => {
    if (w.isDestroyed()) return
    w.show()
    w.focus()
    sendTo(w.webContents, SETTINGS.quickEntryShown)
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function hideQuickEntry(): void {
  win?.hide()
}

export function toggleQuickEntry(): void {
  if (win && win.isVisible() && win.isFocused()) hideQuickEntry()
  else showQuickEntry()
}

/** Destroys the window (app quitting, or the main window closed without the tray). */
export function closeQuickEntry(): void {
  win?.destroy()
  win = undefined
}

export async function pickFolderForQuickEntry(defaultPath?: string): Promise<string | undefined> {
  const w = win
  ignoreBlur = true
  try {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], defaultPath }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? undefined : res.filePaths[0]
  } finally {
    ignoreBlur = false
    if (w && !w.isDestroyed()) w.focus()
  }
}

// ---- Global shortcut ----

export function quickEntryStatus(): QuickEntryStatus {
  return status
}

/** (Re)registers the shortcut from settings and broadcasts the outcome. */
export function applyQuickEntryShortcut(): QuickEntryStatus {
  const accelerator = settings().get().quickEntryShortcut ?? ''
  if (registered) globalShortcut.unregister(registered)
  registered = undefined
  status = { accelerator, registered: false, suspended }
  if (accelerator && !suspended) {
    try {
      if (globalShortcut.register(accelerator, toggleQuickEntry)) {
        registered = accelerator
        status.registered = true
      } else {
        status.error = 'Não foi possível registrar: o atalho já está em uso por outro aplicativo.'
      }
    } catch {
      status.error = 'Atalho inválido.'
    }
  }
  broadcast(SETTINGS.quickEntryStatusChanged, status)
  return status
}

/** Called on every settings change; re-registers only when the accelerator changed. */
export function onSettingsChangedForQuickEntry(): void {
  if ((settings().get().quickEntryShortcut ?? '') !== status.accelerator) applyQuickEntryShortcut()
}

/** Releases the shortcut while the settings UI records a new one, so pressing the old combo doesn't fire it. */
export function suspendQuickEntryShortcut(value: boolean): QuickEntryStatus {
  suspended = value
  return applyQuickEntryShortcut()
}

export function stopQuickEntry(): void {
  if (registered) globalShortcut.unregister(registered)
  registered = undefined
  closeQuickEntry()
}
