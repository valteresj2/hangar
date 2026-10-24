// Feature "sessions" — main process side. Owned by the sessions agent.
import type { Feature } from '../../core/feature'

export const sessionsFeature: Feature = {
  name: 'sessions',
  register() {
    // TODO(sessions): register ipcMain handlers using channels from src/shared/features/sessions.ts
  }
}
