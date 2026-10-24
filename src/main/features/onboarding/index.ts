// Feature "onboarding" — main process side. Owned by the onboarding agent.
import type { Feature } from '../../core/feature'

export const onboardingFeature: Feature = {
  name: 'onboarding',
  register() {
    // TODO(onboarding): register ipcMain handlers using channels from src/shared/features/onboarding.ts
  }
}
