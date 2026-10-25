// IPC channels and payload types for the "sessions" feature. Owned by the sessions agent.
import type { Effort, PermissionMode, Session, Worktree } from '../contracts'

export const SESSIONS = {
  create: 'sessions:create',
  delete: 'sessions:delete',
  exportMarkdown: 'sessions:exportMarkdown',
  listCli: 'sessions:listCli',
  importCli: 'sessions:importCli'
} as const

/** Placeholder title; the engine replaces it with one derived from the first prompt. */
export const DEFAULT_SESSION_TITLE = 'Nova sessão'

/**
 * Renderer-side DOM event (window.dispatchEvent) that opens the "import from Claude Code" dialog.
 * Lets other features (e.g. the command palette) trigger it without importing sessions code.
 */
export const OPEN_IMPORT_EVENT = 'hangar:sessions:open-import'

/** `sessions:create` (input) → Session. Missing options fall back to settings() defaults. */
export interface CreateSessionInput {
  cwd: string
  id?: string
  title?: string
  projectId?: string
  groupId?: string
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  worktree?: Worktree
}

/** `sessions:delete` (id, opts?) → DeleteSessionResult */
export interface DeleteSessionOptions {
  /** Also remove the session's git worktree folder (git also drops the hangar/* branch if it has no unmerged commits). */
  removeWorktree?: boolean
}

export interface DeleteSessionResult {
  deleted: boolean
  /** Set when the session was deleted but removing its worktree failed. */
  worktreeError?: string
}

/** `sessions:listCli` () → CliSessionInfo[] (newest first). */
export interface CliSessionInfo {
  sdkSessionId: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  /** Number of user + assistant lines in the transcript (rough size indicator). */
  messages: number
  /** True when a Hangar session already points at this Claude Code session. */
  imported: boolean
}

/** `sessions:importCli` (sdkSessionIds) → ImportCliResult */
export interface ImportCliResult {
  imported: number
  skipped: number
}

// `sessions:exportMarkdown` (id) → string | undefined (saved file path; undefined when the dialog was canceled).

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [SESSIONS.create]: (input: CreateSessionInput) => Session
    [SESSIONS.delete]: (id: string, opts?: DeleteSessionOptions) => DeleteSessionResult
    [SESSIONS.exportMarkdown]: (id: string) => string | undefined
    [SESSIONS.listCli]: () => CliSessionInfo[]
    [SESSIONS.importCli]: (ids: string[]) => ImportCliResult
  }
}
