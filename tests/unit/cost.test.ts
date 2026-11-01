import { describe, expect, it } from 'vitest'
import { isCostUnknown } from '../../src/renderer/src/features/engine/cost'

const turn = {
  tokens: 1200,
  viaPlatform: false,
  platformCost: undefined,
  estimated: true,
  reportedUsd: 0,
  model: 'deepseek/deepseek-v4.1-flash'
}

describe('chat footer: unknown cost', () => {
  it('a token model without prices in the platform catalog', () => {
    expect(isCostUnknown({ ...turn, viaPlatform: true })).toBe(true)
    expect(isCostUnknown({ ...turn, viaPlatform: true, platformCost: 0 })).toBe(true)
    expect(isCostUnknown({ ...turn, viaPlatform: true, platformCost: 0.0021 })).toBe(false)
  })

  it('a non-Claude model through a gateway that Claude Code reports as free', () => {
    expect(isCostUnknown(turn)).toBe(true)
    expect(isCostUnknown({ ...turn, reportedUsd: 0.004 })).toBe(false)
    // Claude models are priced by Claude Code itself.
    expect(isCostUnknown({ ...turn, model: 'claude-sonnet-4-5' })).toBe(false)
    // The subscription is not billed per token: its figure stays.
    expect(isCostUnknown({ ...turn, estimated: false })).toBe(false)
  })

  it('a turn without tokens is just zero', () => {
    expect(isCostUnknown({ ...turn, tokens: 0 })).toBe(false)
  })
})
