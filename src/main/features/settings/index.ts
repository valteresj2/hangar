// Feature "settings" — main process side. Owned by the settings agent.
// CLI info/login, MCP servers, skills/plugins, scheduled tasks, theme, notifications, tray, Quick Entry and
// provider profiles.

import { app, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { StoreChange } from '../../../shared/contracts'
import {
  SETTINGS,
  type AppInfo,
  type McpAddInput,
  type McpToggleInput,
  type ProviderInput,
  type ScheduledTaskInput
} from '../../../shared/features/settings'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { settings } from '../../core/store'
import { authStatus, cliInfo } from './cli'
import { claudeDir, listPlugins, listSkills } from './extensions'
import { mcpAdd, mcpGet, mcpList, mcpLog, mcpRemove, mcpSetEnabled } from './mcp'
import {
  clearProviderSecret,
  deleteProvider,
  loadProviders,
  maskSecrets,
  providersState,
  saveProvider,
  setDefaultProvider,
  setProviderSecret,
  testProvider
} from './providers'
import {
  applyQuickEntryShortcut,
  hideQuickEntry,
  onSettingsChangedForQuickEntry,
  pickFolderForQuickEntry,
  quickEntryStatus,
  stopQuickEntry,
  suspendQuickEntryShortcut
} from './quickEntry'
import {
  deleteSchedule,
  listSchedules,
  runTask,
  saveSchedule,
  startSchedules,
  stopSchedules,
  validateCron
} from './schedules'
import { showMainAndSend, showNotification, startTrayAndNotifications, stopTrayAndNotifications } from './tray'

function applyTheme(): void {
  const theme = settings().get().theme
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
}

const onStoreChanged = (change: StoreChange) => {
  if (change.collection !== 'settings') return
  applyTheme()
  onSettingsChangedForQuickEntry()
}

export const settingsFeature: Feature = {
  name: 'settings',
  register(ctx) {
    applyTheme()
    bus.on('store:changed', onStoreChanged)

    ipcMain.handle(SETTINGS.cliInfo, () => cliInfo())
    ipcMain.handle(SETTINGS.authStatus, () => authStatus())
    ipcMain.handle(SETTINGS.pickFile, async (_e, defaultPath?: string) => {
      const win = ctx.mainWindow()
      const opts: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        defaultPath,
        filters: process.platform === 'win32' ? [{ name: 'Executáveis', extensions: ['exe', 'cmd', 'bat'] }] : undefined
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? undefined : res.filePaths[0]
    })
    ipcMain.handle(SETTINGS.testNotification, () =>
      showNotification(ctx, 'Hangar', 'As notificações estão funcionando.')
    )
    ipcMain.handle(SETTINGS.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      dataDir: join(app.getPath('userData'), 'hangar-data')
    }))

    ipcMain.handle(SETTINGS.mcpList, (_e, cwd?: string) => mcpList(cwd))
    ipcMain.handle(SETTINGS.mcpGet, (_e, name: string, cwd?: string) => mcpGet(name, cwd))
    ipcMain.handle(SETTINGS.mcpAdd, (_e, input: McpAddInput) => mcpAdd(input))
    ipcMain.handle(SETTINGS.mcpRemove, (_e, name: string, scope?: string, cwd?: string) => mcpRemove(name, scope, cwd))
    ipcMain.handle(SETTINGS.mcpSetEnabled, (_e, input: McpToggleInput) => mcpSetEnabled(input))
    ipcMain.handle(SETTINGS.mcpLog, (_e, name: string, cwd?: string) => mcpLog(name, cwd))

    ipcMain.handle(SETTINGS.skills, () => listSkills())
    ipcMain.handle(SETTINGS.plugins, () => listPlugins())
    ipcMain.handle(SETTINGS.claudeDir, () => claudeDir())

    ipcMain.handle(SETTINGS.schedulesList, () => listSchedules())
    ipcMain.handle(SETTINGS.schedulesSave, (_e, input: ScheduledTaskInput) => saveSchedule(input))
    ipcMain.handle(SETTINGS.schedulesDelete, (_e, id: string) => deleteSchedule(id))
    ipcMain.handle(SETTINGS.schedulesRunNow, (_e, id: string) => runTask(id, true))
    ipcMain.handle(SETTINGS.cronValidate, (_e, expr: string) => validateCron(expr))

    // Provider errors can echo input back; never let a secret ride along in an IPC error.
    const guarded =
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      async (_e: unknown, ...args: A): Promise<Awaited<R>> => {
        try {
          return await fn(...args)
        } catch (err) {
          // eslint-disable-next-line preserve-caught-error -- the original error may carry a secret; it is dropped on purpose
          throw new Error(maskSecrets(err instanceof Error ? err.message : String(err)))
        }
      }
    ipcMain.handle(SETTINGS.providersList, () => providersState())
    ipcMain.handle(
      SETTINGS.providerSave,
      guarded((input: ProviderInput) => saveProvider(input))
    )
    ipcMain.handle(
      SETTINGS.providerDelete,
      guarded((id: string) => deleteProvider(id))
    )
    ipcMain.handle(
      SETTINGS.providerSetSecret,
      guarded((id: string, secret: string) => setProviderSecret(id, secret))
    )
    ipcMain.handle(
      SETTINGS.providerClearSecret,
      guarded((id: string) => clearProviderSecret(id))
    )
    ipcMain.handle(
      SETTINGS.providerSetDefault,
      guarded((id: string) => setDefaultProvider(id))
    )
    ipcMain.handle(SETTINGS.providerTest, (_e, id: string) => testProvider(id))

    ipcMain.handle(SETTINGS.quickEntryStatus, () => quickEntryStatus())
    ipcMain.handle(SETTINGS.quickEntrySuspend, (_e, suspended: boolean) => suspendQuickEntryShortcut(suspended))
    ipcMain.handle(SETTINGS.quickEntryHide, () => hideQuickEntry())
    ipcMain.handle(SETTINGS.quickEntryPickFolder, (_e, defaultPath?: string) => pickFolderForQuickEntry(defaultPath))
    ipcMain.handle(SETTINGS.quickEntryDone, (_e, sessionId: string) => {
      hideQuickEntry()
      showMainAndSend(ctx, SETTINGS.focusSession, { sessionId })
    })

    // Awaited through providersReady() before the first window opens.
    void loadProviders()
    startSchedules()
    startTrayAndNotifications(ctx)
    applyQuickEntryShortcut()
  },
  dispose() {
    bus.off('store:changed', onStoreChanged)
    stopSchedules()
    stopQuickEntry()
    stopTrayAndNotifications()
  }
}
