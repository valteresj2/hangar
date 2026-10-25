// Feature "onboarding" — main process side. Owned by the onboarding agent.
// Diagnosis for the first-run assistant (and the gateway fix offered on provider errors).
import { ONBOARDING, type DiagnoseOptions, type ProviderSummary } from '../../../shared/features/onboarding'
import { SUBSCRIPTION_PROFILE_ID } from '../../../shared/providers'
import type { Feature } from '../../core/feature'
import { settings } from '../../core/store'
import { listProviders } from '../settings/providers'
import { applyDirectFix, diagnose } from './diagnose'
import { handle } from '../../core/handle'

export const onboardingFeature: Feature = {
  name: 'onboarding',
  register() {
    handle(ONBOARDING.diagnose, (_e, opts?: DiagnoseOptions) => diagnose(opts))
    handle(ONBOARDING.applyDirectFix, () => applyDirectFix())
    handle(ONBOARDING.providerSummary, (): ProviderSummary => {
      const all = listProviders()
      const p =
        all.find((x) => x.id === settings().get().defaultProviderId) ??
        all.find((x) => x.id === SUBSCRIPTION_PROFILE_ID)!
      return { id: p.id, name: p.name, kind: p.kind, customProfiles: all.length - 1 }
    })
  }
}
