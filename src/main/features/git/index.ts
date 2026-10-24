// Feature "git" — main process side. Owned by the git agent.
import type { Feature } from '../../core/feature'

export const gitFeature: Feature = {
  name: 'git',
  register() {
    // TODO(git): register ipcMain handlers using channels from src/shared/features/git.ts
  }
}
