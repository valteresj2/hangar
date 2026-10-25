// IPC channels and payload types for the "updater" feature. Owned by the updater agent.
export const UPDATER = {
  /** () → UpdaterState */
  state: 'updater:state',
  /** () → UpdaterState — checks the feed now (result also arrives as evState). */
  check: 'updater:check',
  /** () → void — downloads the available update in the background. */
  download: 'updater:download',
  /** () → void — quits, runs the installer and relaunches. Only valid once status is 'downloaded'. */
  install: 'updater:install',
  /** (enabled: boolean) → UpdaterState — download updates as soon as they are found. */
  setAutoDownload: 'updater:setAutoDownload',
  /** () → boolean — manual installs: opens UpdaterState.downloadUrl in the browser (false when there is none). */
  openDownload: 'updater:openDownload',

  /** main → renderer: UpdaterState after every change. */
  evState: 'updater:event:state'
} as const

export type UpdaterStatus =
  | 'disabled' // dev build without a test feed, or no publish config
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/**
 * 'auto': electron-updater downloads and installs (Windows NSIS, Linux AppImage).
 * 'manual': the app only reports the new version and links to its download (macOS without an Apple Developer ID,
 * the Windows portable .exe, the Linux .deb).
 */
export type InstallMode = 'auto' | 'manual'

export interface UpdaterProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdaterState {
  status: UpdaterStatus
  currentVersion: string
  /** Update channel ('latest', 'beta', …). */
  channel: string
  /** Why updates are disabled (status 'disabled'). */
  disabledReason?: string
  availableVersion?: string
  releaseDate?: string
  /** Plain-text release notes, when the feed has them. */
  releaseNotes?: string
  progress?: UpdaterProgress
  /** Readable message (pt-BR) for status 'error'. */
  error?: string
  lastCheckedAt?: number
  autoDownload: boolean
  installMode: InstallMode
  /** installMode 'manual': why this installation cannot update itself (pt-BR). */
  manualReason?: string
  /** installMode 'manual' with an update available: https page to download it from. */
  downloadUrl?: string
  /** Absolute path of the updater log file. */
  logFile: string
}

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [UPDATER.state]: () => UpdaterState
    [UPDATER.check]: () => UpdaterState
    [UPDATER.download]: () => void
    [UPDATER.install]: () => void
    [UPDATER.setAutoDownload]: (enabled: boolean) => UpdaterState
    [UPDATER.openDownload]: () => boolean
  }

  interface IpcEventContract {
    [UPDATER.evState]: UpdaterState
  }
}
