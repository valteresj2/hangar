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

/**
 * How Hangar adapts Claude Code to models that are not Claude (src/shared/compat.ts, engine/compat/).
 * Claude Code treats any custom base URL as the Anthropic API, so non-Claude models behind a gateway get Anthropic
 * fields they reject (effort, context management, adaptive thinking, 32k max_tokens) and a toolset tuned for Claude.
 */
export type CompatMode =
  /** Adapt requests for models whose id is not a Claude model (default). */
  | 'auto'
  /** Adapt every model of this profile (gateways that rename Claude-looking ids). */
  | 'on'
  /** Send Claude Code's requests unchanged. */
  | 'off'

export interface ProviderCompat {
  mode?: CompatMode
  /** The model's real context window, when the built-in table does not know it. */
  contextWindow?: number
  /** The model's output token limit, when the built-in table does not know it. */
  maxOutputTokens?: number
  /** Tools for adapted models: `core` (default) keeps the file, shell and search tools; `full` keeps Claude Code's set. */
  toolset?: 'core' | 'full'
  /** Whether the model reasons (thinking is passed to the gateway as a token budget). Default: from the table. */
  reasoning?: boolean
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
  /** gateway: adaptation for non-Claude models (default: auto). */
  compat?: ProviderCompat
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
  /** The profile's kind and model mapping, for the engine's compatibility layer. */
  kind?: ProviderKind
  models?: ProviderModels
  /** gateway profiles: how non-Claude models are adapted. */
  compat?: ProviderCompat
}
