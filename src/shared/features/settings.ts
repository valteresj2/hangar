// IPC channels and payload types for the "settings" feature. Owned by the settings agent.
import type { PermissionMode } from '../contracts'

export const SETTINGS = {
  // Claude Code CLI
  cliInfo: 'settings:cliInfo', // () => CliInfo
  authStatus: 'settings:authStatus', // () => AuthStatus
  pickFile: 'settings:pickFile', // (defaultPath?) => string | undefined
  testNotification: 'settings:testNotification', // () => boolean
  appInfo: 'settings:appInfo', // () => AppInfo

  // MCP servers (through `claude mcp ...`)
  mcpList: 'settings:mcpList', // (cwd?) => McpListResult
  mcpGet: 'settings:mcpGet', // (name, cwd?) => CliResult
  mcpAdd: 'settings:mcpAdd', // (input: McpAddInput) => CliResult
  mcpRemove: 'settings:mcpRemove', // (name, scope?, cwd?) => CliResult
  mcpSetEnabled: 'settings:mcpSetEnabled', // (input: McpToggleInput) => McpToggleResult
  mcpLog: 'settings:mcpLog', // (name, cwd?) => McpLog

  // Skills and plugins (read-only)
  skills: 'settings:skills', // () => SkillInfo[]
  plugins: 'settings:plugins', // () => PluginInfo[]
  claudeDir: 'settings:claudeDir', // () => string (~/.claude)

  // Scheduled tasks
  schedulesList: 'settings:schedulesList', // () => ScheduledTask[]
  schedulesSave: 'settings:schedulesSave', // (task: ScheduledTaskInput) => ScheduledTask
  schedulesDelete: 'settings:schedulesDelete', // (id) => boolean
  schedulesRunNow: 'settings:schedulesRunNow', // (id) => ScheduleRun
  cronValidate: 'settings:cronValidate', // (expr) => CronCheck

  // Quick Entry (global shortcut + small always-on-top window)
  quickEntryStatus: 'settings:quickEntryStatus', // () => QuickEntryStatus
  quickEntrySuspend: 'settings:quickEntrySuspend', // (suspended: boolean) => QuickEntryStatus (while recording a shortcut)
  quickEntryHide: 'settings:quickEntryHide', // () => void
  quickEntryPickFolder: 'settings:quickEntryPickFolder', // (defaultPath?) => string | undefined
  quickEntryDone: 'settings:quickEntryDone', // (sessionId) => void: hide, show main window, focus the session

  // Events main -> renderer
  focusSession: 'settings:event:focusSession', // { sessionId }
  newSession: 'settings:event:newSession', // void (tray "Nova sessão")
  schedulesChanged: 'settings:event:schedulesChanged', // void
  quickEntryStatusChanged: 'settings:event:quickEntryStatus', // QuickEntryStatus
  quickEntryShown: 'settings:event:quickEntryShown' // void (sent to the Quick Entry window each time it opens)
} as const

export interface CliResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface CliInfo {
  /** Resolved executable, or undefined when not found. */
  path?: string
  /** True when the path came from the user override in Settings. */
  fromOverride: boolean
  /** Output of `claude --version`. */
  version?: string
  error?: string
}

export interface AuthStatus {
  loggedIn: boolean
  /** e.g. 'claude.ai' (subscription) or 'apiKey'. */
  authMethod?: string
  subscriptionType?: string
  email?: string
  orgName?: string
  error?: string
}

export type McpScope = 'local' | 'user' | 'project' | 'claude.ai' | 'unknown'
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpHealth = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'unknown'

/**
 * How a server is (or can be) switched off:
 * - 'project':  per-project opt-out list `disabledMcpServers` in ~/.claude.json (what /mcp toggles write);
 * - 'mcpjson':  `disabledMcpjsonServers` / `enabledMcpjsonServers` in <folder>/.claude/settings.local.json (.mcp.json servers);
 * - 'hangar':   user-scope server removed with `claude mcp remove`, its config kept by Hangar to re-add later;
 * - 'settings': rejected by `disabledMcpjsonServers` in a shared or user settings file (Hangar doesn't edit those).
 */
export type McpDisableMechanism = 'project' | 'mcpjson' | 'hangar' | 'settings'

export interface McpServer {
  name: string
  scope: McpScope
  /** Command line or URL as printed by the CLI. */
  target: string
  transport?: string
  health: McpHealth
  /** Status text as printed by the CLI (without the symbol). */
  statusText: string
  /** Names of env vars / headers configured (values are never sent to the renderer). */
  envKeys?: string[]
  headerKeys?: string[]
  /** Set when the server is switched off, with the mechanism that did it. */
  disabledBy?: McpDisableMechanism
  /** Mechanism a per-project toggle would use for this server in the listed folder (undefined: no toggle). */
  projectToggle?: 'project' | 'mcpjson'
  /** True for user-scope servers, which can be switched off everywhere (remove + keep config). */
  canDisableEverywhere: boolean
}

export interface McpListResult {
  ok: boolean
  servers: McpServer[]
  /** Folder the list was computed for (undefined: no project, CLI ran in the home folder). */
  cwd?: string
  /** Raw CLI output, shown when parsing fails. */
  raw: string
  error?: string
}

export interface McpAddInput {
  name: string
  scope: 'local' | 'user' | 'project'
  transport: McpTransport
  /** Folder used as cwd for local/project scope. */
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpToggleInput {
  name: string
  enabled: boolean
  /** 'project' / 'mcpjson' need `cwd`; 'hangar' works everywhere (user scope only). */
  mechanism: 'project' | 'mcpjson' | 'hangar'
  cwd?: string
}

export interface McpToggleResult {
  ok: boolean
  message: string
}

export interface McpLog {
  /** Folder with this server's logs (exists or not). */
  dir: string
  /** Newest log file, when there is one. */
  file?: string
  modifiedAt?: number
  /** Formatted lines from the end of the file. */
  lines: string[]
  /** True when only the tail of a large file was read. */
  truncated: boolean
  error?: string
}

export interface QuickEntryStatus {
  /** Accelerator from settings ('' = disabled). */
  accelerator: string
  registered: boolean
  suspended: boolean
  error?: string
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  /** 'user' for ~/.claude/skills/<name>, 'synced' for skills synced from claude.ai. */
  source: 'user' | 'synced'
}

export interface PluginInfo {
  id: string
  name: string
  marketplace?: string
  version?: string
  description?: string
  scope?: string
  enabled?: boolean
  installPath?: string
}

export type ScheduleResult = 'running' | 'success' | 'error'

export interface ScheduleRun {
  at: number
  sessionId?: string
  result: ScheduleResult
  manual: boolean
  error?: string
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  cwd: string
  prompt: string
  model?: string
  permissionMode?: PermissionMode
  enabled: boolean
  lastRunAt?: number
  lastResult?: ScheduleResult
  /** Most recent runs first, capped. */
  history?: ScheduleRun[]
  /** Computed by main when listing; not persisted. */
  nextRunAt?: number
}

export type ScheduledTaskInput = Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult' | 'history' | 'nextRunAt'> & {
  id?: string
}

export interface CronCheck {
  valid: boolean
  error?: string
  next?: number[]
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  dataDir: string
}
