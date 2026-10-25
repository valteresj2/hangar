// IPC channels and payload types for the "preview" feature. Owned by the preview agent.
import { MOTION_EXTENSION } from '../motion/spec'

export const PREVIEW = {
  // Dev servers (.claude/launch.json)
  launchConfigs: 'preview:launchConfigs',
  launchSave: 'preview:launchSave',
  start: 'preview:start',
  stop: 'preview:stop',
  servers: 'preview:servers',
  logs: 'preview:logs',
  // Artifacts
  artifacts: 'preview:artifacts',
  artifactRead: 'preview:artifactRead',
  artifactAdd: 'preview:artifactAdd',
  artifactRemove: 'preview:artifactRemove',
  artifactReveal: 'preview:artifactReveal',
  artifactOpen: 'preview:artifactOpen',
  artifactStat: 'preview:artifactStat',
  artifactWrite: 'preview:artifactWrite',
  // Hangar Motion
  motionAssets: 'preview:motionAssets',
  exportDialog: 'preview:exportDialog',
  exportOpen: 'preview:exportOpen',
  exportWrite: 'preview:exportWrite',
  exportClose: 'preview:exportClose',
  showInFolder: 'preview:showInFolder',
  // Events (main -> renderer)
  serverEvent: 'preview:event:server',
  artifactsEvent: 'preview:event:artifacts',
  popupEvent: 'preview:event:popup',
  downloadEvent: 'preview:event:download'
} as const

/** Partition shared by every embedded browser tab. */
export const BROWSER_PARTITION = 'persist:hangar-browser'

// ---- Dev servers ----

/** One entry of `.claude/launch.json`. */
export interface LaunchConfiguration {
  name: string
  runtimeExecutable: string
  runtimeArgs?: string[]
  port?: number
  url?: string
}

export interface LaunchFile {
  version?: string
  configurations: LaunchConfiguration[]
}

/** Result of `preview:launchConfigs`. */
export interface LaunchConfigsResult {
  /** Absolute path of the launch.json file (may not exist yet). */
  path: string
  exists: boolean
  /** Raw file text, so the UI can edit it. */
  text?: string
  configurations: LaunchConfiguration[]
  /** Parse/validation error, when the file exists but is invalid. */
  error?: string
}

/** Result of `preview:launchSave` (sessionId, text, overwrite). */
export type LaunchSaveResult = { ok: true; path: string } | { ok: false; exists?: boolean; error: string }

export type ServerStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'error'

export interface ServerInfo {
  id: string
  sessionId: string
  name: string
  cwd: string
  command: string
  port?: number
  url?: string
  status: ServerStatus
  pid?: number
  exitCode?: number | null
  error?: string
  startedAt: number
}

/** Payload of `preview:event:server`. `ready` is set once, when the port first answers. */
export type ServerEvent =
  | { type: 'state'; server: ServerInfo; ready?: boolean }
  | { type: 'log'; serverId: string; sessionId: string; chunk: string }

// ---- Artifacts ----

export type ArtifactKind = 'html' | 'svg' | 'markdown' | 'mermaid' | 'motion'

export const ARTIFACT_EXTENSIONS: Record<string, ArtifactKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.md': 'markdown',
  '.mermaid': 'mermaid'
}

/** Artifact kind of a file path; `*.motion.json` is checked before plain extensions. */
export function artifactKindOf(path: string): ArtifactKind | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith(MOTION_EXTENSION)) return 'motion'
  const dot = lower.lastIndexOf('.')
  return dot < 0 ? undefined : ARTIFACT_EXTENSIONS[lower.slice(dot)]
}

export interface Artifact {
  id: string
  sessionId: string
  path: string
  name: string
  kind: ArtifactKind
  addedAt: number
  updatedAt: number
}

/** Result of `preview:artifactRead` (path). */
export interface ArtifactContent {
  artifact: Artifact
  content: string
  mtime: number
  size: number
  /** Isolated http://localhost URL to frame (html / mermaid). Missing if the local server is unavailable. */
  url?: string
  truncated?: boolean
}

/** Payload of `preview:event:artifacts`. */
export interface ArtifactsEvent {
  sessionId: string
  /** Set when a single artifact was added or rewritten. */
  artifactId?: string
}

/** Payload of `preview:event:popup`: a webview tried to open a new window. */
export interface PopupEvent {
  /** webContents id of the guest that asked for the popup. */
  sourceId: number
  url: string
}

/** Payload of `preview:event:download`. */
export interface DownloadEvent {
  id: string
  filename: string
  state: 'started' | 'completed' | 'cancelled' | 'interrupted'
  savePath?: string
}

/** Result of `preview:artifactStat` (id). */
export interface ArtifactStat {
  exists: boolean
  mtime: number
}

/** Result of `preview:artifactWrite` (id, text). Only motion artifacts can be written. */
export interface ArtifactWriteResult {
  mtime: number
}

/** Result of `preview:motionAssets` (artifactId, srcs): data: URLs keyed by the element `src`. Failed ones are missing. */
export type MotionAssetUrls = Record<string, string>

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [PREVIEW.launchConfigs]: (sessionId: string) => LaunchConfigsResult
    [PREVIEW.launchSave]: (sessionId: string, text: string, overwrite?: boolean) => LaunchSaveResult
    [PREVIEW.start]: (sessionId: string, name: string) => ServerInfo
    [PREVIEW.stop]: (serverId: string) => void
    [PREVIEW.servers]: (sessionId?: string) => ServerInfo[]
    [PREVIEW.logs]: (serverId: string) => string
    [PREVIEW.artifacts]: (sessionId: string) => Artifact[]
    [PREVIEW.artifactRead]: (pathOrId: string) => ArtifactContent
    [PREVIEW.artifactAdd]: (sessionId: string, path?: string) => Artifact | undefined
    [PREVIEW.artifactRemove]: (id: string) => boolean
    [PREVIEW.artifactReveal]: (id: string) => void
    [PREVIEW.artifactOpen]: (id: string) => void
    [PREVIEW.artifactStat]: (id: string) => ArtifactStat
    [PREVIEW.artifactWrite]: (id: string, text: string) => ArtifactWriteResult
    [PREVIEW.motionAssets]: (id: string, srcs: string[]) => MotionAssetUrls
    [PREVIEW.exportDialog]: (sessionId: string, title: string) => string | undefined
    [PREVIEW.exportOpen]: (path: string) => string
    [PREVIEW.exportWrite]: (id: string, position: number, data: Uint8Array) => void
    [PREVIEW.exportClose]: (id: string, commit: boolean) => void
    [PREVIEW.showInFolder]: (path: string) => void
  }

  interface IpcEventContract {
    [PREVIEW.serverEvent]: ServerEvent
    [PREVIEW.artifactsEvent]: ArtifactsEvent
    [PREVIEW.popupEvent]: PopupEvent
    [PREVIEW.downloadEvent]: DownloadEvent
  }
}
