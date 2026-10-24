// IPC channels and payload types for the "onboarding" feature. Owned by the onboarding agent.

export const ONBOARDING = {
  /** (opts?: DiagnoseOptions) → DiagnosticReport */
  diagnose: 'onboarding:diagnose',
  /** () → DirectFixResult — creates (or reuses) "Assinatura (direto)", makes it the default and tests it */
  applyDirectFix: 'onboarding:applyDirectFix',
  /** () → ProviderSummary — the default provider profile (no secrets) */
  providerSummary: 'onboarding:providerSummary'
} as const

export interface ProviderSummary {
  id: string
  name: string
  kind: string
  /** Number of provider profiles besides the built-in subscription. */
  customProfiles: number
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip'

export type CheckId = 'claude' | 'login' | 'gateway' | 'provider' | 'direct' | 'git'

/** What the UI can offer next to a check. */
export type DiagnosticAction =
  | { kind: 'applyDirectFix'; label: string }
  | { kind: 'openProviders'; label: string }
  | { kind: 'openUrl'; label: string; url: string }

export interface DiagnosticItem {
  id: CheckId
  title: string
  status: CheckStatus
  /** Plain-language explanation (Portuguese). Never contains secret values. */
  message: string
  /** Extra detail (versions, URLs, masked errors). */
  detail?: string
  action?: DiagnosticAction
}

/** Where Claude Code gets an endpoint override from (values of secrets are never reported). */
export interface GatewayInfo {
  /** Effective ANTHROPIC_BASE_URL for a plain Claude Code launch, if any. */
  baseUrl?: string
  /** Where the effective value came from. */
  source?: 'settings' | 'userEnv' | 'processEnv'
  /** ANTHROPIC_BASE_URL in ~/.claude/settings.json (env block). */
  settingsBaseUrl?: string
  /** ANTHROPIC_BASE_URL in the Windows user environment / the environment Hangar was started with. */
  userEnvBaseUrl?: string
  processEnvBaseUrl?: string
  /** Credential variables present (names only). */
  credentialVars: string[]
  /** `apiKeyHelper` configured in ~/.claude/settings.json. */
  apiKeyHelper: boolean
  /** True when the effective base URL is not Anthropic's own API. */
  isGateway: boolean
}

export interface DiagnoseOptions {
  /** Only the gateway and provider checks (used by the session error card). */
  quick?: boolean
  /** Provider profile to test instead of the default one. */
  providerId?: string
}

export interface DiagnosticReport {
  items: DiagnosticItem[]
  gateway: GatewayInfo
  /** "Assinatura (direto)" would fix the failure (default fails, direct works). */
  fixAvailable: boolean
  /** Name of the provider profile that was tested. */
  providerName?: string
  ranAt: number
}

export interface DirectFixResult {
  ok: boolean
  profileId?: string
  profileName?: string
  /** Whether the profile already existed. */
  reused?: boolean
  /** Connection test of the new default. */
  testOk?: boolean
  message: string
}
