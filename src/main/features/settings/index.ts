// Feature "settings" — main process side. Owned by the settings agent.
import type { Feature } from '../../core/feature'

export const settingsFeature: Feature = {
  name: 'settings',
  register() {
    // TODO(settings): register ipcMain handlers using channels from src/shared/features/settings.ts
  }
}
