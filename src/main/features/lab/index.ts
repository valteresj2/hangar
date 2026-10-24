// Feature "lab" — main process side. Owned by the lab agent.
import type { Feature } from '../../core/feature'

export const labFeature: Feature = {
  name: 'lab',
  register() {
    // TODO(lab): register ipcMain handlers using channels from src/shared/features/lab.ts
  }
}
