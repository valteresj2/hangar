// Core domain types shared by main, preload and renderer.
// Owned by the chief (integration). Feature agents may ADD optional fields
// but must not rename or remove existing ones.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SessionStatus = 'idle' | 'working' | 'waiting' | 'error'
export type ThemePref = 'system' | 'light' | 'dark'

export interface Worktree {
  path: string
  branch: string
  baseCwd: string
}

export interface Session {
  id: string
  title: string
  cwd: string
  projectId?: string
  groupId?: string
  pinned: boolean
  archived: boolean
  unread: boolean
  status: SessionStatus
  createdAt: number
  updatedAt: number
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  fastMode?: boolean
  /** Claude Code session id, used to resume the conversation. */
  sdkSessionId?: string
  worktree?: Worktree
}

export interface Project {
  id: string
  name: string
  cwd: string
  instructions?: string
  createdAt: number
}

export interface Group {
  id: string
  name: string
  order: number
  collapsed?: boolean
}

export interface Settings {
  theme: ThemePref
  defaultModel: string
  defaultEffort: Effort
  defaultPermissionMode: PermissionMode
  /** Optional override for the claude executable; defaults to the one on PATH. */
  claudeExecutablePath?: string
  notifications: boolean
  recentFolders: string[]
  pinnedFolders: string[]
  /** Closing the main window hides it to the tray instead of quitting. */
  minimizeToTray: boolean
  /** Electron accelerator for the global Quick Entry shortcut; empty string disables it. */
  quickEntryShortcut: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultModel: 'opus',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  notifications: true,
  recentFolders: [],
  pinnedFolders: [],
  minimizeToTray: true,
  quickEntryShortcut: 'CommandOrControl+Alt+Space'
}

/** Collections persisted by the core store (src/main/core/store.ts). */
export interface Collections {
  sessions: Session
  projects: Project
  groups: Group
}
export type CollectionName = keyof Collections

/** Payload of the `store:changed` event broadcast to every window. */
export interface StoreChange {
  collection: CollectionName | 'settings'
  id?: string
}

/** Side panel tabs. Each feature registers its own tab component in the renderer. */
export type SidePanelTab = 'terminal' | 'changes' | 'files' | 'browser' | 'artifacts' | 'harness'
