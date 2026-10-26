// Compat layer, engine side: what a Claude Code launch changes for a model that is not Claude.
//
// Two halves: the local proxy (./proxy.ts) adapts each request by its model, and compatSession() below decides the
// launch-time part (environment, toolset, thinking, effort and the extra instructions) for the session's model.
import type { ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  compatApplies,
  compatInstructions,
  CORE_TOOLS,
  modelTraits,
  resolveModelAlias,
  type ModelTraits
} from '../../../../shared/compat'
import type { ProviderLaunch } from '../../../../shared/providers'

export { compatProxyRunning, registerRoute, releaseRoute, routeStats, startCompatProxy, stopCompatProxy } from './proxy'
export type { CompatStats } from './transform'

export interface CompatSession {
  /** The model's traits; undefined when the profile cannot reach non-Claude models (or compat is off). */
  traits?: ModelTraits
  adapted: boolean
  /** Variables for the Claude Code process (also put in the flag settings so they outrank settings.json). */
  env: Record<string, string>
  /** Built-in tools to offer (undefined: Claude Code's default set). */
  tools?: string[]
  thinking?: ThinkingConfig
  /** Leave `effort` out of the options. */
  dropEffort: boolean
  /** Appended to the system prompt. */
  append?: string
}

const NONE: CompatSession = { adapted: false, env: {}, dropEffort: false }

type LaunchShape = Pick<ProviderLaunch, 'kind' | 'compat' | 'models' | 'env'>

/** Launch-time adaptation for `model` (the session's model or alias) under a resolved provider launch. */
export function compatSession(
  launch: LaunchShape,
  model: string | undefined,
  platform = process.platform
): CompatSession {
  if (!compatApplies(launch.kind, launch.compat)) return NONE
  const resolved = resolveModelAlias(model, launch.models)
  if (!resolved) return NONE
  const traits = modelTraits(resolved, launch.compat)
  if (!traits.adapted) return { ...NONE, traits }

  const env: Record<string, string> = {
    // Deferred tools need the tool_reference blocks only the Anthropic API resolves.
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    // Unknown models get a 200k window by default: compact before the real window overflows.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(traits.contextWindow),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(traits.contextWindow),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(traits.maxOutputTokens, 128_000)),
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1'
  }
  if (!traits.reasoning) env.CLAUDE_CODE_DISABLE_THINKING = '1'
  // Background calls (titles, Bash command checks, summaries) go to the "haiku" model; on a gateway without a
  // mapping that is a Claude id the gateway does not serve, so every one of them would fail and be retried.
  if (!launch.models?.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolved
    env.ANTHROPIC_SMALL_FAST_MODEL = resolved
  }
  if (!launch.models?.sonnet && !launch.models?.opus) env.CLAUDE_CODE_SUBAGENT_MODEL = resolved
  // The profile's own extra variables win.
  for (const name of Object.keys(env)) if (launch.env[name] !== undefined) delete env[name]

  const core = (launch.compat?.toolset ?? 'core') === 'core'
  return {
    traits,
    adapted: true,
    env,
    tools: core ? CORE_TOOLS : undefined,
    thinking: traits.reasoning
      ? { type: 'enabled', budgetTokens: Math.min(8_192, Math.floor(traits.maxOutputTokens / 2)) }
      : { type: 'disabled' },
    dropEffort: true,
    append: compatInstructions({ shell: platform === 'win32' ? 'powershell' : 'bash' })
  }
}

/** Whether moving a session from model `a` to `b` changes the launch-time adaptation (the query must restart). */
export function compatChanges(launch: LaunchShape, a: string | undefined, b: string | undefined): boolean {
  return compatSession(launch, a).adapted !== compatSession(launch, b).adapted
}
