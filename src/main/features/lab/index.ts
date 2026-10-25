// Feature "lab" — main process side. Owned by the lab agent.
// Harness Lab: the same task runs with the current harness (base) and variants, each in its own git
// worktree and session; the deliverables are then compared blind. Keeping the base is a valid outcome.
// Variants are written by hand (manual) or by INV/DOM proposers and a composer (parallel / sequential).
// Concept adapted from google-research/harness2 (Apache-2.0).
import type { StoreChange } from '../../../shared/contracts'
import { LAB, type CreateLabRoundInput } from '../../../shared/features/lab'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import {
  adopt,
  adoptReview,
  createReview,
  askClaudeToChoose,
  blindCandidates,
  cancelRound,
  chooseCandidate,
  cleanup,
  createRound,
  listRounds,
  prepare,
  reconcile,
  reflectRound,
  removeRound
} from './rounds'
import { enforceCap, onSessionsChanged, onTurnEnded } from './runs'
import { flush, roundEvents } from './store'
import { handle } from '../../core/handle'

export const labFeature: Feature = {
  name: 'lab',
  register() {
    handle(LAB.list, (_e, projectCwd: string) => listRounds(projectCwd))
    handle(LAB.prepare, (_e, projectCwd: string) => prepare(projectCwd))
    handle(LAB.create, (_e, input: CreateLabRoundInput) => createRound(input))
    handle(LAB.cancel, (_e, roundId: string) => cancelRound(roundId))
    handle(LAB.candidates, (_e, roundId: string) => blindCandidates(roundId))
    handle(LAB.choose, (_e, roundId: string, anonId: string, why: string) => chooseCandidate(roundId, anonId, why))
    handle(LAB.askClaude, (_e, roundId: string) => askClaudeToChoose(roundId))
    handle(LAB.adopt, (_e, roundId: string, apply: boolean, confirmExec?: string) => adopt(roundId, apply, confirmExec))
    handle(LAB.adoptReview, (_e, roundId: string) => adoptReview(roundId))
    handle(LAB.createReview, (_e, input: CreateLabRoundInput) => createReview(input))
    handle(LAB.reflect, (_e, roundId: string) => reflectRound(roundId))
    handle(LAB.cleanup, (_e, roundId: string) => cleanup(roundId))
    handle(LAB.remove, (_e, roundId: string) => removeRound(roundId))

    bus.on('session:turn-ended', ({ sessionId }: { sessionId: string }) => {
      onTurnEnded(sessionId).catch((err) => console.error('[lab] turn-ended handling failed', err))
    })
    bus.on('store:changed', (change: StoreChange) => {
      if (change.collection === 'sessions') onSessionsChanged()
    })

    // The cost cap is checked on every change of a round (runs and proposer calls report cost when they end).
    roundEvents.on('changed', (roundId: string) => enforceCap(roundId))

    reconcile().catch((err) => console.error('[lab] reconcile failed', err))
  },
  dispose() {
    flush()
  }
}
