// Feature "preview" — main process side. Owned by the preview agent.
import type { Feature } from '../../core/feature'

export const previewFeature: Feature = {
  name: 'preview',
  register() {
    // TODO(preview): register ipcMain handlers using channels from src/shared/features/preview.ts
  }
}
