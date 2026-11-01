// Whether a turn's cost can be shown at all (the chat footer).
import { isClaudeModel } from '@shared/compat'

/**
 * True when there is nothing to price the turn by: a token model without prices in the platform's catalog, or a
 * non-Claude model that Claude Code (which only knows Anthropic's list prices) reports as free. Showing
 * "US$ 0.0000" there would read as "it cost nothing".
 */
export function isCostUnknown(t: {
  /** Input (with cache) plus output tokens of the turn. */
  tokens: number
  /** A token model of the platform (priced by its catalog). */
  viaPlatform: boolean
  /** The platform-priced cost, undefined when the catalog has no price. */
  platformCost: number | undefined
  /** A provider profile other than the subscription (Claude Code's own figure is then an estimate). */
  estimated: boolean
  /** Claude Code's figure (`total_cost_usd`). */
  reportedUsd: number
  model: string | undefined
}): boolean {
  if (t.tokens <= 0) return false
  if (t.viaPlatform) return !t.platformCost
  return t.estimated && t.reportedUsd === 0 && !isClaudeModel(t.model)
}
