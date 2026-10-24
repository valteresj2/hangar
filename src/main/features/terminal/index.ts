// Feature "terminal" — main process side. Owned by the terminal agent.
import { ipcMain } from 'electron'
import type { StoreChange } from '../../../shared/contracts'
import { TERMINAL, type CreateTerminalOptions } from '../../../shared/features/terminal'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { db } from '../../core/store'
import {
  createTerminal,
  disposeAll,
  killTerminal,
  killWhere,
  listTerminals,
  renameTerminal,
  resizeTerminal,
  shells,
  writeTerminal
} from './manager'

/** Kills the PTYs of sessions that no longer exist in the store. */
function onStoreChanged(change: StoreChange): void {
  if (change.collection !== 'sessions') return
  const sessions = db('sessions')
  killWhere((info) => {
    const session = sessions.get(info.sessionId)
    return !session || session.archived
  })
}

export const terminalFeature: Feature = {
  name: 'terminal',
  register() {
    ipcMain.handle(TERMINAL.create, (_e, opts: CreateTerminalOptions) => createTerminal(opts))
    ipcMain.handle(TERMINAL.write, (_e, id: string, data: string) => writeTerminal(id, data))
    ipcMain.handle(TERMINAL.resize, (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
    ipcMain.handle(TERMINAL.kill, (_e, id: string) => killTerminal(id))
    ipcMain.handle(TERMINAL.rename, (_e, id: string, title: string) => renameTerminal(id, title))
    ipcMain.handle(TERMINAL.list, (_e, sessionId?: string) => listTerminals(sessionId))
    ipcMain.handle(TERMINAL.shells, () => shells())
    bus.on('store:changed', onStoreChanged)
  },
  dispose() {
    bus.off('store:changed', onStoreChanged)
    disposeAll()
  }
}
