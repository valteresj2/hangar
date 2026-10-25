// Provider profiles: how a session reaches a model. Owned by the chief.
// Claude Code (and so the Agent SDK) is configured through environment variables; a profile is a named,
// validated set of them plus one secret kept encrypted in the main process (never sent back to the renderer).

export type ProviderKind =
  /** Claude Code's own login (Claude subscription) and the user's ~/.claude/settings.json, untouched. */
  | 'subscription'
  /** Anthropic API with an API key. */
  | 'anthropic'
  /** Any Anthropic-compatible gateway: LiteLLM proxy, OpenRouter, a corporate gateway… (OpenAI, Gemini and other
   *  models are reached by pointing the gateway at them; Claude Code only speaks the Anthropic Messages API). */
  | 'gateway'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

/** Model aliases the composer offers for a profile; empty fields fall back to Claude Code's defaults. */
export interface ProviderModels {
  /** Used when the session has no explicit model. */
  default?: string
  opus?: string
  sonnet?: string
  haiku?: string
  /** Extra model ids offered as-is in the composer (e.g. LiteLLM model names). */
  extra?: string[]
}

export interface ProviderProfile {
  id: string
  name: string
  kind: ProviderKind
  /** gateway / anthropic (optional override) / foundry. */
  baseUrl?: string
  /** gateway: how the secret is sent. */
  authStyle?: 'bearer' | 'x-api-key'
  /** bedrock / vertex / foundry region. */
  region?: string
  /** vertex project id; foundry resource name. */
  project?: string
  /** bedrock: named AWS profile instead of a key. */
  awsProfile?: string
  models?: ProviderModels
  /** Additional non-secret environment variables (validated names only). */
  extraEnv?: Record<string, string>
  /** Set on profiles the app maintains itself (read-only in Settings → Provedores). */
  managedBy?: 'platform'
  /** Agent Hangar LLM connection this managed profile proxies (docs/platform/app-api-models.md). */
  platformConnectionId?: number
  /** Whether an encrypted secret is stored for this profile. The secret itself never leaves main. */
  hasSecret: boolean
  createdAt: number
  updatedAt: number
}

/** The built-in profile that keeps today's behavior. Always present, cannot be deleted. */
export const SUBSCRIPTION_PROFILE_ID = 'subscription'

/** Result of resolving a profile for a Claude Code launch (main process only). */
export interface ProviderLaunch {
  /** Variables to set on the Claude Code process. */
  env: Record<string, string>
  /** Variables to remove from the inherited environment. */
  unset: string[]
  /** Passed as the SDK `settings` override (flag settings outrank ~/.claude/settings.json). */
  settingsEnv: Record<string, string>
  /** Default model for sessions without an explicit one. */
  defaultModel?: string
}
