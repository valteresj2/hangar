// Auto-update controller over electron-updater.
// Active only in the packaged app (reads resources/app-update.yml written by electron-builder from `publish`).
// In dev, HANGAR_UPDATE_URL=<generic feed url> enables it against a test server (forceDevUpdateConfig).

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { UPDATER, type UpdaterState } from '../../../shared/features/updater'
import { broadcast } from '../../core/broadcast'
import { markQuitting } from '../../core/window'
import { readableUpdateError } from './errors'
import { fileLogger, logFilePath } from './log'

const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

interface Prefs {
  autoDownload: boolean
}

let updater: AppUpdater | undefined
let state: UpdaterState
let timers: NodeJS.Timeout[] = []
let checking: Promise<void> | undefined

function prefsFile(): string {
  return join(app.getPath('userData'), 'hangar-data', 'updater', 'prefs.json')
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(prefsFile(), 'utf8')) as Partial<Prefs>
    return { autoDownload: raw.autoDownload === true }
  } catch {
    return { autoDownload: false }
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    mkdirSync(dirname(prefsFile()), { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2), 'utf8')
  } catch (err) {
    fileLogger.warn('could not save updater prefs', err)
  }
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  broadcast(UPDATER.evState, state)
}

function notesText(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (!notes) return undefined
  const text = typeof notes === 'string' ? notes : notes.map((n) => `${n.version}\n${n.note ?? ''}`).join('\n\n')
  // GitHub release notes arrive as HTML.
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return plain ? plain.slice(0, 4000) : undefined
}

function initialState(): UpdaterState {
  return {
    status: 'disabled',
    currentVersion: app.getVersion(),
    channel: 'latest',
    autoDownload: readPrefs().autoDownload,
    logFile: logFilePath()
  }
}

/** Why the updater cannot run in this process, or undefined when it can. */
function disabledReason(): string | undefined {
  if (!app.isPackaged) {
    return process.env.HANGAR_UPDATE_URL ? undefined : 'Atualizações automáticas só funcionam no app instalado.'
  }
  if (process.platform !== 'win32') return 'Atualizações automáticas só estão disponíveis no Windows por enquanto.'
  if (!existsSync(join(process.resourcesPath, 'app-update.yml')))
    return 'Este build não tem configuração de atualização.'
  return undefined
}

function wire(u: AppUpdater): void {
  u.on('checking-for-update', () => setState({ status: 'checking', error: undefined }))
  u.on('update-available', (info: UpdateInfo) =>
    setState({
      status: u.autoDownload ? 'downloading' : 'available',
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: notesText(info),
      progress: undefined,
      lastCheckedAt: Date.now()
    })
  )
  u.on('update-not-available', () =>
    setState({ status: 'not-available', availableVersion: undefined, progress: undefined, lastCheckedAt: Date.now() })
  )
  u.on('download-progress', (p: ProgressInfo) =>
    setState({
      status: 'downloading',
      progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }
    })
  )
  u.on('update-downloaded', (info: UpdateInfo) =>
    setState({
      status: 'downloaded',
      availableVersion: info.version,
      releaseNotes: notesText(info) ?? state.releaseNotes
    })
  )
  u.on('error', (err: Error) => {
    fileLogger.error('updater error', err)
    setState({ status: 'error', error: readableUpdateError(err), progress: undefined, lastCheckedAt: Date.now() })
  })
}

export function getState(): UpdaterState {
  return state
}

export async function startUpdater(): Promise<void> {
  state = initialState()
  const reason = disabledReason()
  if (reason) {
    state = { ...state, disabledReason: reason }
    fileLogger.info('updater disabled:', reason)
    return
  }

  let u: AppUpdater
  try {
    // electron-updater is CJS; under interop its exports may sit on `default`.
    const mod = await import('electron-updater')
    u = mod.autoUpdater ?? (mod as unknown as { default: typeof mod }).default.autoUpdater
  } catch (err) {
    fileLogger.error('could not load electron-updater', err)
    setState({ disabledReason: 'Não foi possível carregar o módulo de atualização.' })
    return
  }
  u.logger = fileLogger
  u.autoDownload = state.autoDownload
  u.autoInstallOnAppQuit = true
  // We ship the full NSIS installer, never the web installer.
  u.disableWebInstaller = true
  if (!app.isPackaged && process.env.HANGAR_UPDATE_URL) {
    // Dev/test feed. A config file (not setFeedURL) is needed: downloads read updaterCacheDirName from it.
    const file = join(app.getPath('userData'), 'hangar-data', 'updater', 'dev-app-update.yml')
    mkdirSync(dirname(file), { recursive: true })
    const url = JSON.stringify(process.env.HANGAR_UPDATE_URL)
    writeFileSync(file, `provider: generic\nurl: ${url}\nupdaterCacheDirName: hangar-updater-dev\n`, 'utf8')
    u.forceDevUpdateConfig = true
    u.updateConfigPath = file
  }
  wire(u)
  updater = u
  setState({ status: 'idle', channel: u.channel ?? 'latest' })
  fileLogger.info(`updater ready (v${state.currentVersion}, channel ${state.channel}, packaged=${app.isPackaged})`)

  timers.push(setTimeout(() => void checkNow(), FIRST_CHECK_DELAY_MS))
  timers.push(setInterval(() => void checkNow(), CHECK_INTERVAL_MS))
  for (const t of timers) t.unref()
}

export async function checkNow(): Promise<UpdaterState> {
  if (!updater) return state
  // Nothing to check while a download is running or an update is waiting for the restart.
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  checking ??= updater
    .checkForUpdates()
    .then(() => undefined)
    .catch((err: unknown) => {
      // Also emitted as 'error'; make sure the state reflects it even if the event did not fire.
      fileLogger.error('checkForUpdates failed', err)
      setState({ status: 'error', error: readableUpdateError(err), lastCheckedAt: Date.now() })
    })
    .finally(() => (checking = undefined))
  await checking
  return state
}

export async function download(): Promise<void> {
  if (!updater || state.status !== 'available') return
  setState({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } })
  try {
    await updater.downloadUpdate()
  } catch (err) {
    fileLogger.error('downloadUpdate failed', err)
    setState({ status: 'error', error: readableUpdateError(err), progress: undefined })
  }
}

export function install(): void {
  if (!updater || state.status !== 'downloaded') return
  fileLogger.info(`quitAndInstall -> v${state.availableVersion}`)
  // Lets windows close even with "minimize to tray" on.
  markQuitting()
  // Not silent (shows the NSIS progress), relaunch the app afterwards.
  updater.quitAndInstall(false, true)
}

export function setAutoDownload(enabled: boolean): UpdaterState {
  writePrefs({ autoDownload: enabled })
  if (updater) updater.autoDownload = enabled
  setState({ autoDownload: enabled })
  // Turning it on with an update already found starts the download right away.
  if (enabled && state.status === 'available') void download()
  return state
}

export function stopUpdater(): void {
  for (const t of timers) clearTimeout(t)
  timers = []
}
