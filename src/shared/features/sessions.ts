// IPC channels and payload types for the "sessions" feature. Owned by the sessions agent.
import type { Effort, PermissionMode, Session, Worktree } from '../contracts'

export const SESSIONS = {
  create: 'sessions:create',
  delete: 'sessions:delete',
  exportMarkdown: 'sessions:exportMarkdown',
  listCli: 'sessions:listCli',
  importCli: 'sessions:importCli',
  listChatgpt: 'sessions:listChatgpt',
  importChatgpt: 'sessions:importChatgpt'
} as const

/** Placeholder title; the engine replaces it with one derived from the first prompt. */
export const DEFAULT_SESSION_TITLE = 'Nova sessão'

/**
 * Renderer-side DOM event (window.dispatchEvent) that opens the "import from the claude CLI" dialog.
 * Lets other features (e.g. the command palette) trigger it without importing sessions code.
 */
export const OPEN_IMPORT_EVENT = 'hangar:sessions:open-import'

/** Same, for the "import from ChatGPT" dialog. */
export const OPEN_CHATGPT_IMPORT_EVENT = 'hangar:sessions:open-chatgpt-import'

/**
 * Renderer-side DOM event (CustomEvent with a NewSessionPreset) that opens the new-session view filled in, e.g.
 * "Conversar" on an agent in Meus agentes. The person still sees the folder, can edit both fields and starts it.
 */
export const NEW_SESSION_PRESET_EVENT = 'hangar:sessions:new-preset'

export interface NewSessionPreset {
  title?: string
  prompt?: string
}

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
  /** Provider profile (src/shared/providers.ts); absent = settings.defaultProviderId. */
  providerId?: string
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

/** A conversation of the ChatGPT desktop app (Work/Codex), from its local data folder (~/.codex). */
export interface ChatgptThreadInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Messages of the person and of ChatGPT (0 when the app's history index is missing). */
  messages: number
  /** True when a Hangar session already holds this conversation. */
  imported: boolean
}

/** A project of the ChatGPT desktop app: a named folder, or a folder used by conversations outside any project. */
export interface ChatgptProjectInfo {
  /** The ChatGPT project id, or `cwd:<folder>` for conversations outside a project. */
  key: string
  name: string
  cwd: string
  /** The folder still exists on this computer (sessions need it). */
  exists: boolean
  /** The folder has an AGENTS.md (ChatGPT's project instructions). */
  agentsMd: boolean
  /** True when a Hangar project already points at this folder. */
  imported: boolean
  threads: ChatgptThreadInfo[]
}

/** `sessions:listChatgpt` () → ChatgptScan */
export interface ChatgptScan {
  /** The ChatGPT desktop app's data folder was found and read. */
  found: boolean
  /** Where it was looked for. */
  dir: string
  projects: ChatgptProjectInfo[]
}

/** `sessions:importChatgpt` (input) → ChatgptImportResult. A thread's project comes along. */
export interface ChatgptImportInput {
  projects: string[]
  threads: string[]
}

export interface ChatgptImportResult {
  projects: number
  sessions: number
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
    [SESSIONS.listChatgpt]: () => ChatgptScan
    [SESSIONS.importChatgpt]: (input: ChatgptImportInput) => ChatgptImportResult
  }
}
