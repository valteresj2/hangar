// Feature "harness" — main process side. Owned by the harness agent.
import type { Feature } from '../../core/feature'

export const harnessFeature: Feature = {
  name: 'harness',
  register() {
    // TODO(harness): register ipcMain handlers using channels from src/shared/features/harness.ts
  }
}
