// Feature "updater" — main process side. Owned by the updater agent.
// Auto-update via electron-updater: check on start and every 6 h, background download, restart & install.
// Installations that cannot update themselves (macOS ad hoc, Windows portable, Linux .deb) only link to the download.
import { UPDATER } from '../../../shared/features/updater'
import type { Feature } from '../../core/feature'
import {
  checkNow,
  download,
  getState,
  install,
  openDownload,
  setAutoDownload,
  startUpdater,
  stopUpdater
} from './controller'
import { handle } from '../../core/handle'

export const updaterFeature: Feature = {
  name: 'updater',
  register() {
    // The initial state is set synchronously; loading electron-updater continues in the background.
    void startUpdater()
    handle(UPDATER.state, () => getState())
    handle(UPDATER.check, () => checkNow())
    handle(UPDATER.download, () => download())
    handle(UPDATER.install, () => install())
    handle(UPDATER.setAutoDownload, (_e, enabled: boolean) => setAutoDownload(enabled === true))
    handle(UPDATER.openDownload, () => openDownload())
  },
  dispose() {
    stopUpdater()
  }
}
