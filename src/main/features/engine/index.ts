// Feature "engine" — main process side. Owned by the engine agent.
import type { Feature } from '../../core/feature'

export const engineFeature: Feature = {
  name: 'engine',
  register() {
    // TODO(engine): register ipcMain handlers using channels from src/shared/features/engine.ts
  }
}
