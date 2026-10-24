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

  // Events main -> renderer
  focusSession: 'settings:event:focusSession', // { sessionId }
  newSession: 'settings:event:newSession', // void (tray "Nova sessão")
  schedulesChanged: 'settings:event:schedulesChanged' // void
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
export type McpHealth = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unknown'

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
}

export interface McpListResult {
  ok: boolean
  servers: McpServer[]
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
