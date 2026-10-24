// Feature "onboarding" — renderer side. Owned by the onboarding agent.
// OnboardingView: first-run assistant (shown full screen while settings.onboardingDone is false).
// GatewayFixButton: one-click fix offered when a session fails because the gateway in ~/.claude/settings.json is down.
// openDiagnostics: reopens the assistant on its diagnosis step (Settings → Geral).

export { OnboardingView } from './OnboardingView'
export { GatewayFixButton } from './GatewayFixButton'
export { openDiagnostics } from './api'
