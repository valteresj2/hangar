// Feature "platform" — renderer side. Owned by the platform agent.
// PlatformSection: Settings → Plataforma. PlatformStep: onboarding step "Conectar à plataforma".
// PlatformIndicator: sidebar footer. PlatformRequiredNotice: banner where sessions are created (mode `required`).
export { PlatformSection } from './PlatformSection'
export { PlatformStep, platformStepBlocking, platformStepVisible } from './PlatformStep'
export { PlatformIndicator } from './PlatformIndicator'
export { PlatformRequiredNotice } from './PlatformRequired'
export { isPlatformBlocking, useCanCreateSessions, usePlatform } from './api'
