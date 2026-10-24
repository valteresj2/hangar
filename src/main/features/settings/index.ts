// Feature "settings" — main process side. Owned by the settings agent.
// CLI info/login, MCP servers, skills/plugins, scheduled tasks, theme, notifications and tray.

import { app, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { StoreChange } from '../../../shared/contracts'
import { SETTINGS, type AppInfo, type McpAddInput, type ScheduledTaskInput } from '../../../shared/features/settings'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { settings } from '../../core/store'
import { authStatus, cliInfo } from './cli'
import { claudeDir, listPlugins, listSkills } from './extensions'
import { mcpAdd, mcpGet, mcpList, mcpRemove } from './mcp'
import { deleteSchedule, listSchedules, runTask, saveSchedule, startSchedules, stopSchedules, validateCron } from './schedules'
import { showNotification, startTrayAndNotifications, stopTrayAndNotifications } from './tray'

function applyTheme(): void {
  const theme = settings().get().theme
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
}

const onStoreChanged = (change: StoreChange) => {
  if (change.collection === 'settings') applyTheme()
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
    ipcMain.handle(
      SETTINGS.appInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        dataDir: join(app.getPath('userData'), 'hangar-data')
      })
    )

    ipcMain.handle(SETTINGS.mcpList, (_e, cwd?: string) => mcpList(cwd))
    ipcMain.handle(SETTINGS.mcpGet, (_e, name: string, cwd?: string) => mcpGet(name, cwd))
    ipcMain.handle(SETTINGS.mcpAdd, (_e, input: McpAddInput) => mcpAdd(input))
    ipcMain.handle(SETTINGS.mcpRemove, (_e, name: string, scope?: string, cwd?: string) => mcpRemove(name, scope, cwd))

    ipcMain.handle(SETTINGS.skills, () => listSkills())
    ipcMain.handle(SETTINGS.plugins, () => listPlugins())
    ipcMain.handle(SETTINGS.claudeDir, () => claudeDir())

    ipcMain.handle(SETTINGS.schedulesList, () => listSchedules())
    ipcMain.handle(SETTINGS.schedulesSave, (_e, input: ScheduledTaskInput) => saveSchedule(input))
    ipcMain.handle(SETTINGS.schedulesDelete, (_e, id: string) => deleteSchedule(id))
    ipcMain.handle(SETTINGS.schedulesRunNow, (_e, id: string) => runTask(id, true))
    ipcMain.handle(SETTINGS.cronValidate, (_e, expr: string) => validateCron(expr))

    startSchedules()
    startTrayAndNotifications(ctx)
  },
  dispose() {
    bus.off('store:changed', onStoreChanged)
    stopSchedules()
    stopTrayAndNotifications()
  }
}
