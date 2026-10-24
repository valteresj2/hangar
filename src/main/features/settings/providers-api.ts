// Main-side API of provider profiles, used by the engine (and, through it, by every Claude Code launch).
// Owned by the settings agent; the chief fixed these signatures.
import type { ProviderLaunch, ProviderProfile } from '../../../shared/providers'
import { SUBSCRIPTION_PROFILE_ID } from '../../../shared/providers'

/** Every profile, the built-in subscription profile first. Secrets are never included. */
export function listProviders(): ProviderProfile[] {
  return []
}

/**
 * Resolves a profile (undefined → settings().defaultProviderId → subscription) into what a Claude Code
 * launch needs. Synchronous: secrets are decrypted from an in-memory cache loaded at startup.
 */
export function resolveProviderLaunch(_profileId?: string): ProviderLaunch {
  void SUBSCRIPTION_PROFILE_ID
  return { env: {}, unset: ['ANTHROPIC_API_KEY'], settingsEnv: {} }
}
