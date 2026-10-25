// Feature "platform" — renderer side. Owned by the platform agent.
// PlatformSection: Settings → Plataforma. PlatformStep: onboarding step "Conectar à plataforma".
// PlatformIndicator: sidebar footer. PlatformRequiredNotice: banner where sessions are created (mode `required`).
// ModelPicker: the single model picker (subscription, synced token models, other profiles) and its helpers.
export { PlatformSection } from './PlatformSection'
export { PlatformStep, platformStepBlocking, platformStepVisible } from './PlatformStep'
export { PlatformIndicator } from './PlatformIndicator'
export { PlatformRequiredNotice } from './PlatformRequired'
export { isPlatformBlocking, platformApi, useCanCreateSessions, usePlatform } from './api'
export { ModelPicker } from './ModelPicker'
export { estimateCost, formatUsd, modelOrigin, usePlatformModels, useProviderProfiles } from './models'
