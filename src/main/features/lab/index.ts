// Feature "lab" — main process side. Owned by the lab agent.
// Harness Lab, phase 2: the same task runs with the current harness (base) and K variants, each in
// its own git worktree and session; the deliverables are then compared blind. Keeping the base is a
// valid outcome. Concept adapted from google-research/harness2 (Apache-2.0).
import { ipcMain } from 'electron'
import type { StoreChange } from '../../../shared/contracts'
import { LAB, type CreateLabRoundInput } from '../../../shared/features/lab'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import {
  adopt,
  askClaudeToChoose,
  blindCandidates,
  cancelRound,
  chooseCandidate,
  cleanup,
  createRound,
  listRounds,
  onSessionsChanged,
  onTurnEnded,
  prepare,
  reconcile,
  reflectRound,
  removeRound
} from './rounds'
import { flush } from './store'

export const labFeature: Feature = {
  name: 'lab',
  register() {
    ipcMain.handle(LAB.list, (_e, projectCwd: string) => listRounds(projectCwd))
    ipcMain.handle(LAB.prepare, (_e, projectCwd: string) => prepare(projectCwd))
    ipcMain.handle(LAB.create, (_e, input: CreateLabRoundInput) => createRound(input))
    ipcMain.handle(LAB.cancel, (_e, roundId: string) => cancelRound(roundId))
    ipcMain.handle(LAB.candidates, (_e, roundId: string) => blindCandidates(roundId))
    ipcMain.handle(LAB.choose, (_e, roundId: string, anonId: string, why: string) => chooseCandidate(roundId, anonId, why))
    ipcMain.handle(LAB.askClaude, (_e, roundId: string) => askClaudeToChoose(roundId))
    ipcMain.handle(LAB.adopt, (_e, roundId: string, apply: boolean) => adopt(roundId, apply))
    ipcMain.handle(LAB.reflect, (_e, roundId: string) => reflectRound(roundId))
    ipcMain.handle(LAB.cleanup, (_e, roundId: string) => cleanup(roundId))
    ipcMain.handle(LAB.remove, (_e, roundId: string) => removeRound(roundId))

    bus.on('session:turn-ended', ({ sessionId }: { sessionId: string }) => {
      onTurnEnded(sessionId).catch((err) => console.error('[lab] turn-ended handling failed', err))
    })
    bus.on('store:changed', (change: StoreChange) => {
      if (change.collection === 'sessions') onSessionsChanged()
    })

    reconcile().catch((err) => console.error('[lab] reconcile failed', err))
  },
  dispose() {
    flush()
  }
}
