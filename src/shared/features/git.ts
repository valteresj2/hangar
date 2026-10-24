// IPC channels and payload types for the "git" feature. Owned by the git agent.
export const GIT = {
  isRepo: 'git:isRepo',
  worktreeCreate: 'git:worktreeCreate',
  worktreeRemove: 'git:worktreeRemove',
  status: 'git:status',
  diff: 'git:diff',
  stage: 'git:stage',
  unstage: 'git:unstage',
  discard: 'git:discard',
  commit: 'git:commit',
  branches: 'git:branches',
  checkout: 'git:checkout',
  createBranch: 'git:createBranch',
  push: 'git:push',
  log: 'git:log',
  prStatus: 'git:prStatus',
  /** Start/stop watching a folder; while watched, `changed` fires on file activity. */
  watch: 'git:watch',
  unwatch: 'git:unwatch',
  /** Main -> renderer: something in `cwd` changed, refetch status. Payload: GitChangedEvent. */
  changed: 'git:event:changed'
} as const

export const FILES = {
  list: 'files:list',
  find: 'files:find',
  read: 'files:read',
  openInEditor: 'files:openInEditor'
} as const

/** Porcelain status letter. `?` = untracked, `U` = unmerged (conflict). */
export type GitChangeCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface GitFileChange {
  /** Path relative to the repository root, forward slashes. */
  path: string
  /** Source path of a rename/copy. */
  origPath?: string
  status: GitChangeCode
}

export interface GitStatus {
  isRepo: boolean
  /** Absolute repository root (native separators). */
  root?: string
  /** Current branch name; undefined when detached or not a repo. */
  branch?: string
  detached: boolean
  /** Short HEAD sha; undefined before the first commit. */
  head?: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  /** True when the file lists were capped. */
  truncated: boolean
}

export interface GitDiffRequest {
  path: string
  origPath?: string
  /** Diff index vs HEAD instead of working tree vs index. */
  staged?: boolean
  untracked?: boolean
}

export interface GitDiffResult {
  /** Unified diff text (may be empty when there is nothing to show). */
  text: string
  binary: boolean
  truncated: boolean
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
  upstream?: string
  /** Unix seconds of the tip commit. */
  date: number
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  /** Unix seconds. */
  date: number
  subject: string
}

export interface GitPrStatus {
  available: boolean
  number?: number
  title?: string
  state?: string
  url?: string
  isDraft?: boolean
}

export interface GitChangedEvent {
  cwd: string
}

export interface FileEntry {
  name: string
  /** Absolute path. */
  path: string
  isDir: boolean
  size?: number
  /** Matched by .gitignore (only set inside a repo). */
  ignored?: boolean
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  /** True when only the first FILE_READ_LIMIT bytes were returned. */
  truncated: boolean
  text?: string
}

export const FILE_READ_LIMIT = 1024 * 1024

/** Case- and separator-insensitive path comparison (Windows-friendly). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return norm(a) === norm(b)
}
