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
  }

  interface IpcEventContract {
    [UPDATER.evState]: UpdaterState
  }
}
