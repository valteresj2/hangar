// Core IPC: generic store access and small app utilities.

import { dialog, shell, app } from 'electron'
import type { CollectionName, Settings } from '../../shared/contracts'
import { CORE } from '../../shared/ipc'
import type { FeatureContext } from './feature'
import { openExternalLink } from './window'
import { db, settings } from './store'
import { handle } from './handle'

export function registerCoreIpc(ctx: FeatureContext): void {
  handle(CORE.storeList, (_e, name: CollectionName) => db(name).list())
  handle(CORE.storeGet, (_e, name: CollectionName, id: string) => db(name).get(id))
  handle(CORE.storePut, (_e, name, row) => db(name).put(row))
  handle(CORE.storePatch, (_e, name, id, patch) => db(name).patch(id, patch))
  handle(CORE.storeDelete, (_e, name: CollectionName, id: string) => db(name).delete(id))
  handle(CORE.settingsGet, () => settings().get())
  handle(CORE.settingsPatch, (_e, patch: Partial<Settings>) => settings().patch(patch))

  handle(CORE.pickFolder, async (_e, defaultPath?: string) => {
    const win = ctx.mainWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] as const, defaultPath }
    const res = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
    return res.canceled ? undefined : res.filePaths[0]
  })
  handle(CORE.openExternal, (_e, url: string) => openExternalLink(url, ctx.mainWindow()))
  handle(CORE.openPath, (_e, path: string) => shell.openPath(path))
  handle(CORE.homeDir, () => app.getPath('home'))
}
