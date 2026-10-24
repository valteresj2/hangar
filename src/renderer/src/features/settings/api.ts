// Typed wrappers for the settings feature's IPC channels.
import {
  SETTINGS,
  type AppInfo,
  type AuthStatus,
  type CliInfo,
  type CliResult,
  type CronCheck,
  type McpAddInput,
  type McpListResult,
  type McpLog,
  type McpToggleInput,
  type McpToggleResult,
  type ProviderInput,
  type ProvidersState,
  type ProviderTestResult,
  type QuickEntryStatus,
  type PluginInfo,
  type ScheduleRun,
  type ScheduledTask,
  type ScheduledTaskInput,
  type SkillInfo
} from '@shared/features/settings'
import type { ProviderProfile } from '@shared/providers'
import { bridge } from '../../core/api'

export const settingsApi = {
  cliInfo: () => bridge.invoke<CliInfo>(SETTINGS.cliInfo),
  authStatus: () => bridge.invoke<AuthStatus>(SETTINGS.authStatus),
  pickFile: (defaultPath?: string) => bridge.invoke<string | undefined>(SETTINGS.pickFile, defaultPath),
  testNotification: () => bridge.invoke<boolean>(SETTINGS.testNotification),
  appInfo: () => bridge.invoke<AppInfo>(SETTINGS.appInfo),
  mcpList: (cwd?: string) => bridge.invoke<McpListResult>(SETTINGS.mcpList, cwd),
  mcpGet: (name: string, cwd?: string) => bridge.invoke<CliResult>(SETTINGS.mcpGet, name, cwd),
  mcpAdd: (input: McpAddInput) => bridge.invoke<CliResult>(SETTINGS.mcpAdd, input),
  mcpRemove: (name: string, scope?: string, cwd?: string) => bridge.invoke<CliResult>(SETTINGS.mcpRemove, name, scope, cwd),
  mcpSetEnabled: (input: McpToggleInput) => bridge.invoke<McpToggleResult>(SETTINGS.mcpSetEnabled, input),
  mcpLog: (name: string, cwd?: string) => bridge.invoke<McpLog>(SETTINGS.mcpLog, name, cwd),
  skills: () => bridge.invoke<SkillInfo[]>(SETTINGS.skills),
  plugins: () => bridge.invoke<PluginInfo[]>(SETTINGS.plugins),
  claudeDir: () => bridge.invoke<string>(SETTINGS.claudeDir),
  schedules: () => bridge.invoke<ScheduledTask[]>(SETTINGS.schedulesList),
  saveSchedule: (task: ScheduledTaskInput) => bridge.invoke<ScheduledTask>(SETTINGS.schedulesSave, task),
  deleteSchedule: (id: string) => bridge.invoke<boolean>(SETTINGS.schedulesDelete, id),
  runSchedule: (id: string) => bridge.invoke<ScheduleRun>(SETTINGS.schedulesRunNow, id),
  validateCron: (expr: string) => bridge.invoke<CronCheck>(SETTINGS.cronValidate, expr),
  providers: () => bridge.invoke<ProvidersState>(SETTINGS.providersList),
  saveProvider: (input: ProviderInput) => bridge.invoke<ProviderProfile>(SETTINGS.providerSave, input),
  deleteProvider: (id: string) => bridge.invoke<boolean>(SETTINGS.providerDelete, id),
  setProviderSecret: (id: string, secret: string) => bridge.invoke<ProviderProfile>(SETTINGS.providerSetSecret, id, secret),
  clearProviderSecret: (id: string) => bridge.invoke<ProviderProfile>(SETTINGS.providerClearSecret, id),
  setDefaultProvider: (id: string) => bridge.invoke(SETTINGS.providerSetDefault, id),
  testProvider: (id: string) => bridge.invoke<ProviderTestResult>(SETTINGS.providerTest, id),
  quickEntryStatus: () => bridge.invoke<QuickEntryStatus>(SETTINGS.quickEntryStatus),
  quickEntrySuspend: (suspended: boolean) => bridge.invoke<QuickEntryStatus>(SETTINGS.quickEntrySuspend, suspended),
  quickEntryHide: () => bridge.invoke(SETTINGS.quickEntryHide),
  quickEntryPickFolder: (defaultPath?: string) => bridge.invoke<string | undefined>(SETTINGS.quickEntryPickFolder, defaultPath),
  quickEntryDone: (sessionId: string) => bridge.invoke(SETTINGS.quickEntryDone, sessionId)
}

/** Message of an error thrown across IPC, without Electron's "Error invoking remote method" prefix. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Combined, trimmed CLI output for display. */
export function cliOutput(res: CliResult): string {
  return [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n')
}
