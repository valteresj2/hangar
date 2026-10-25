// Core IPC: generic store access and small app utilities.

import { dialog, ipcMain, shell, app } from 'electron'
import type { CollectionName, Settings } from '../../shared/contracts'
import { CORE } from '../../shared/ipc'
import type { FeatureContext } from './feature'
import { openExternalLink } from './window'
import { db, settings } from './store'

export function registerCoreIpc(ctx: FeatureContext): void {
  ipcMain.handle(CORE.storeList, (_e, name: CollectionName) => db(name).list())
  ipcMain.handle(CORE.storeGet, (_e, name: CollectionName, id: string) => db(name).get(id))
  ipcMain.handle(CORE.storePut, (_e, name: CollectionName, row: any) => db(name).put(row))
  ipcMain.handle(CORE.storePatch, (_e, name: CollectionName, id: string, patch: any) => db(name).patch(id, patch))
  ipcMain.handle(CORE.storeDelete, (_e, name: CollectionName, id: string) => db(name).delete(id))
  ipcMain.handle(CORE.settingsGet, () => settings().get())
  ipcMain.handle(CORE.settingsPatch, (_e, patch: Partial<Settings>) => settings().patch(patch))

  ipcMain.handle(CORE.pickFolder, async (_e, defaultPath?: string) => {
    const win = ctx.mainWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] as const, defaultPath }
    const res = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle(CORE.openExternal, (_e, url: string) => openExternalLink(url, ctx.mainWindow()))
  ipcMain.handle(CORE.openPath, (_e, path: string) => shell.openPath(path))
  ipcMain.handle(CORE.homeDir, () => app.getPath('home'))
}
