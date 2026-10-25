// Typed wrappers for the onboarding feature's IPC channels, plus the navigation store.
import { create } from 'zustand'
import { ONBOARDING, type DiagnoseOptions } from '@shared/features/onboarding'
import { api, bridge } from '../../core/api'

export const onboardingApi = {
  diagnose: (opts?: DiagnoseOptions) => bridge.invoke(ONBOARDING.diagnose, opts),
  applyDirectFix: () => bridge.invoke(ONBOARDING.applyDirectFix),
  providerSummary: () => bridge.invoke(ONBOARDING.providerSummary)
}

export type OnboardingStep = 'welcome' | 'platform' | 'diagnose' | 'provider' | 'folder' | 'done'

/** Step the assistant opens on next time it mounts (consumed by OnboardingView). */
export const useOnboardingNav = create<{ startStep?: OnboardingStep }>(() => ({}))

/** Reopens the assistant on the diagnosis step (Settings → Geral → "Rodar diagnóstico"). */
export function openDiagnostics(): void {
  useOnboardingNav.setState({ startStep: 'diagnose' })
  void api.patchSettings({ onboardingDone: false })
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
