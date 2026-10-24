// Feature "updater" — main process side. Owned by the updater agent.
// Auto-update via electron-updater: check on start and every 6 h, background download, restart & install.
import { ipcMain } from 'electron'
import { UPDATER } from '../../../shared/features/updater'
import type { Feature } from '../../core/feature'
import { checkNow, download, getState, install, setAutoDownload, startUpdater, stopUpdater } from './controller'

export const updaterFeature: Feature = {
  name: 'updater',
  register() {
    // The initial state is set synchronously; loading electron-updater continues in the background.
    void startUpdater()
    ipcMain.handle(UPDATER.state, () => getState())
    ipcMain.handle(UPDATER.check, () => checkNow())
    ipcMain.handle(UPDATER.download, () => download())
    ipcMain.handle(UPDATER.install, () => install())
    ipcMain.handle(UPDATER.setAutoDownload, (_e, enabled: boolean) => setAutoDownload(enabled === true))
  },
  dispose() {
    stopUpdater()
  }
}
