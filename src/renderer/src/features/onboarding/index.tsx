// Feature "onboarding" — renderer side. Owned by the onboarding agent.
import { api } from '../../core/api'

/** First-run assistant, shown full screen while settings.onboardingDone is false. */
export function OnboardingView() {
  return (
    <div style={{ padding: 24 }}>
      Bem-vindo ao Hangar <button onClick={() => void api.patchSettings({ onboardingDone: true })}>Pular</button>
    </div>
  )
}

/** One-click fix offered when a session fails because the gateway in ~/.claude/settings.json is down. */
export function GatewayFixButton(_props: { sessionId: string }) {
  return null
}
