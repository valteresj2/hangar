// Feature "terminal" — main process side. Owned by the terminal agent.
import type { Feature } from '../../core/feature'

export const terminalFeature: Feature = {
  name: 'terminal',
  register() {
    // TODO(terminal): register ipcMain handlers using channels from src/shared/features/terminal.ts
  }
}
