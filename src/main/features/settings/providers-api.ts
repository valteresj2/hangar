// Main-side API of provider profiles, used by the engine (and, through it, by every Claude Code launch).
// Owned by the settings agent; the chief fixed these signatures. Implementation in ./providers.ts.
import type { ProviderLaunch, ProviderProfile } from '../../../shared/providers'
import { listProviders as list, resolveLaunch } from './providers'

/** Every profile, the built-in subscription profile first. Secrets are never included. */
export function listProviders(): ProviderProfile[] {
  return list()
}

/**
 * Resolves a profile (undefined → settings().defaultProviderId → subscription) into what a Claude Code
 * launch needs. Synchronous: secrets are decrypted from an in-memory cache loaded at startup.
 * Throws (with a message safe to show) when the profile needs a secret that isn't stored or can't be decrypted.
 */
export function resolveProviderLaunch(profileId?: string): ProviderLaunch {
  return resolveLaunch(profileId)
}
