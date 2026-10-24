// Feature "updater" — main process side. Owned by the updater agent.
import type { Feature } from '../../core/feature'

export const updaterFeature: Feature = {
  name: 'updater',
  register() {
    // TODO(updater): register ipcMain handlers using channels from src/shared/features/updater.ts
  }
}
