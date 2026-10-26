// Typed wrappers for the settings feature's IPC channels.
import {
  SETTINGS,
  type CliResult,
  type McpAddInput,
  type McpToggleInput,
  type ProviderInput,
  type ScheduledTaskInput
} from '@shared/features/settings'
import { bridge } from '../../core/api'

export const settingsApi = {
  cliInfo: () => bridge.invoke(SETTINGS.cliInfo),
  authStatus: () => bridge.invoke(SETTINGS.authStatus),
  pickFile: (defaultPath?: string) => bridge.invoke(SETTINGS.pickFile, defaultPath),
  testNotification: () => bridge.invoke(SETTINGS.testNotification),
  appInfo: () => bridge.invoke(SETTINGS.appInfo),
  thirdPartyNotices: () => bridge.invoke(SETTINGS.thirdPartyNotices),
  mcpList: (cwd?: string) => bridge.invoke(SETTINGS.mcpList, cwd),
  mcpGet: (name: string, cwd?: string) => bridge.invoke(SETTINGS.mcpGet, name, cwd),
  mcpAdd: (input: McpAddInput) => bridge.invoke(SETTINGS.mcpAdd, input),
  mcpRemove: (name: string, scope?: string, cwd?: string) => bridge.invoke(SETTINGS.mcpRemove, name, scope, cwd),
  mcpSetEnabled: (input: McpToggleInput) => bridge.invoke(SETTINGS.mcpSetEnabled, input),
  mcpLog: (name: string, cwd?: string) => bridge.invoke(SETTINGS.mcpLog, name, cwd),
  skills: () => bridge.invoke(SETTINGS.skills),
  plugins: () => bridge.invoke(SETTINGS.plugins),
  claudeDir: () => bridge.invoke(SETTINGS.claudeDir),
  schedules: () => bridge.invoke(SETTINGS.schedulesList),
  saveSchedule: (task: ScheduledTaskInput) => bridge.invoke(SETTINGS.schedulesSave, task),
  deleteSchedule: (id: string) => bridge.invoke(SETTINGS.schedulesDelete, id),
  runSchedule: (id: string) => bridge.invoke(SETTINGS.schedulesRunNow, id),
  validateCron: (expr: string) => bridge.invoke(SETTINGS.cronValidate, expr),
  providers: () => bridge.invoke(SETTINGS.providersList),
  saveProvider: (input: ProviderInput) => bridge.invoke(SETTINGS.providerSave, input),
  deleteProvider: (id: string) => bridge.invoke(SETTINGS.providerDelete, id),
  setProviderSecret: (id: string, secret: string) => bridge.invoke(SETTINGS.providerSetSecret, id, secret),
  clearProviderSecret: (id: string) => bridge.invoke(SETTINGS.providerClearSecret, id),
  setDefaultProvider: (id: string) => bridge.invoke(SETTINGS.providerSetDefault, id),
  testProvider: (id: string) => bridge.invoke(SETTINGS.providerTest, id),
  quickEntryStatus: () => bridge.invoke(SETTINGS.quickEntryStatus),
  quickEntrySuspend: (suspended: boolean) => bridge.invoke(SETTINGS.quickEntrySuspend, suspended),
  quickEntryHide: () => bridge.invoke(SETTINGS.quickEntryHide),
  quickEntryPickFolder: (defaultPath?: string) => bridge.invoke(SETTINGS.quickEntryPickFolder, defaultPath),
  quickEntryDone: (sessionId: string) => bridge.invoke(SETTINGS.quickEntryDone, sessionId)
}

/** Message of an error thrown across IPC, without Electron's "Error invoking remote method" prefix. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Combined, trimmed CLI output for display. */
export function cliOutput(res: CliResult): string {
  return [res.stdout, res.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
}
