// Provider profiles as the engine sees them: which profile a session runs under, its display name, and how to
// recognize (and report without secrets) a failure that comes from the provider rather than from the task.
import { settings } from '../../core/store'
import type { Session } from '../../../shared/contracts'
import { SUBSCRIPTION_PROFILE_ID, type ProviderKind, type ProviderProfile } from '../../../shared/providers'
import { listProviders } from '../settings/providers-api'

export interface ProviderInfo {
  id: string
  name: string
  kind: ProviderKind
}

const BUILTIN_SUBSCRIPTION: ProviderProfile = {
  id: SUBSCRIPTION_PROFILE_ID,
  name: 'Assinatura Claude',
  kind: 'subscription',
  hasSecret: false,
  createdAt: 0,
  updatedAt: 0
}

/** Every profile (no secrets), the built-in subscription first even if the settings feature lists none. */
export function profiles(): ProviderProfile[] {
  let list: ProviderProfile[] = []
  try {
    list = listProviders()
  } catch {
    // Profiles unavailable: offer the subscription only.
  }
  return list.some((p) => p.id === SUBSCRIPTION_PROFILE_ID) ? list : [BUILTIN_SUBSCRIPTION, ...list]
}

/** The profile a session runs under: its own, else the default from settings, else the subscription. */
export function effectiveProviderId(session?: Session): string {
  return session?.providerId || settings().get().defaultProviderId || SUBSCRIPTION_PROFILE_ID
}

export function providerInfo(id: string): ProviderInfo {
  const p = profiles().find((profile) => profile.id === id)
  if (p) return { id: p.id, name: p.name, kind: p.kind }
  return id === SUBSCRIPTION_PROFILE_ID
    ? { id, name: BUILTIN_SUBSCRIPTION.name, kind: 'subscription' }
    : { id, name: id, kind: 'gateway' }
}

/** Authentication, authorization, endpoint and connection errors: the profile's configuration, not the task. */
const PROVIDER_FAILURE =
  /\b(401|403|404)\b|unauthori[sz]ed|forbidden|authenticat|invalid[ _-]?(x-)?api[ _-]?key|api key|credential|permission denied|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|getaddrinfo|connection refused|unable to connect|fetch failed|certificate|self[- ]signed|invalid url|not_found_error|model.*not (found|available)/i

export function isProviderFailure(text: string): boolean {
  return PROVIDER_FAILURE.test(text)
}

/** Removes the launch's secrets and anything shaped like a credential from a message shown to the user. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('••••')
  out = out
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}/g, '$1••••')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1••••')
    .replace(/((?:x-api-key|api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1••••')
  return out.length > 600 ? `${out.slice(0, 600)}…` : out
}
