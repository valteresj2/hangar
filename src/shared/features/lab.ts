// IPC channels and payload types for the "lab" feature. Owned by the lab agent.
import type { PermissionMode, Worktree } from '../contracts'
import type { HarnessSnapshot, HarnessTree, LabMode, LabRound, LabVariant, ReflectResult } from '../harness'

export const LAB = {
  /** (projectCwd) → LabRoundView[], newest first */
  list: 'lab:list',
  /** (projectCwd) → LabPrepareInfo — repo check, current harness and snapshots for the "new round" form */
  prepare: 'lab:prepare',
  /** (input: CreateLabRoundInput) → LabRoundView — creates worktrees/sessions and starts every variant */
  create: 'lab:create',
  /** (roundId) → LabRoundView — interrupts every variant */
  cancel: 'lab:cancel',
  /** (roundId) → BlindCandidate[] — anonymous deliverables, in anon-id order (round must be `selecting`) */
  candidates: 'lab:candidates',
  /** (roundId, anonId, why) → LabRoundView */
  choose: 'lab:choose',
  /** (roundId) → LabRoundView — headless Claude picks a candidate */
  askClaude: 'lab:askClaude',
  /**
   * (roundId, apply: boolean, confirmExec?: string) → AdoptResult. Applying a harness that changes what runs
   * (hooks, helper commands, scripts) requires `confirmExec` = the `fingerprint` of `lab:adoptReview`.
   */
  adopt: 'lab:adopt',
  /** (roundId) → ExecReview — executable changes the winner would bring into the project */
  adoptReview: 'lab:adoptReview',
  /** (input: CreateLabRoundInput) → VariantExecReview[] — executable changes of each manual variant vs the base */
  createReview: 'lab:createReview',
  /** (roundId) → ReflectResult */
  reflect: 'lab:reflect',
  /** (roundId) → LabRoundView — removes worktrees and archives the round's sessions */
  cleanup: 'lab:cleanup',
  /** (roundId) → void — forgets a finished round */
  remove: 'lab:remove',
  /** Main → renderer: a round changed. Payload: LabRoundView. */
  evRound: 'lab:event:round',
  /** Main → renderer: a round was removed. Payload: { roundId }. */
  evRemoved: 'lab:event:removed'
} as const

export const LAB_GROUP_NAME = 'Harness Lab'
export const BASE_VARIANT_ID = 'base'
/** Limit of the diff excerpt kept per variant (characters). */
export const LAB_DIFF_LIMIT = 20_000

export interface LabPrepareInfo {
  isRepo: boolean
  /** True when the repository has at least one commit (worktrees start from HEAD). */
  hasHead: boolean
  /** Uncommitted changes outside the harness surface: worktrees will not see them. */
  dirty: boolean
  baseTree: HarnessTree
  snapshots: HarnessSnapshot[]
}

export interface LabVariantInput {
  label: string
  tree: HarnessTree
  snapshotId?: string
}

export interface CreateLabRoundInput {
  projectCwd: string
  task: string
  model?: string
  permissionMode?: PermissionMode
  /** Manual variants besides the base (1..MAX_LAB_VARIANTS). Empty in the automatic modes. */
  variants: LabVariantInput[]
  /** Absent = manual. */
  mode?: LabMode
  /** k for 'parallel' (1..LAB_PARALLEL_MAX), K for 'sequential' (1..LAB_SEQUENTIAL_MAX). */
  depth?: number
  /** Model of the proposer/composer calls; absent = settings default. */
  proposerModel?: string
  /** Stops the round once runs + calls cost more than this (USD). */
  costCapUsd?: number
  /**
   * Manual rounds whose variants change what runs (hooks, scripts): the combined `fingerprint` of
   * `lab:createReview`, proving the user saw the list. Without it such a round is refused.
   */
  confirmExec?: string
}

/** One change to what a harness can execute (or allow) on the user's machine. */
export interface ExecChange {
  /** Harness path, e.g. `.claude/settings.json` or `.claude/skills/x/scripts/run.sh`. */
  path: string
  change: 'added' | 'modified' | 'removed'
  kind: 'hook' | 'command' | 'permission' | 'env' | 'script' | 'inline-command'
  /** What changes: the command line, permission rule, variable or file. */
  detail: string
}

export interface ExecReview {
  changes: ExecChange[]
  /** Hash of `changes`; echoed back to confirm exactly this list. Empty when there is nothing to confirm. */
  fingerprint: string
}

export interface VariantExecReview extends ExecReview {
  label: string
}

/** One step of the automatic pipeline, aggregated so it does not reveal which run is which. */
export interface LabPhaseView {
  key: string
  title: string
  status: 'pending' | 'running' | 'done' | 'error'
  /** Items in the phase (calls or runs) and how many finished. */
  total: number
  finished: number
  costUsd?: number
  durationMs?: number
  /** Proposals that needed a retry or fell back to the current harness. */
  retries?: number
  fallbacks?: number
}

/** What one run delivered, as the selector sees it. */
export interface LabDeliverable {
  finalAnswer: string
  diffStat: string
  diffExcerpt: string
  diffTruncated: boolean
  errors: string[]
}

export interface BlindCandidate extends LabDeliverable {
  anonId: string
}

export interface LabVariantView extends LabVariant {
  worktree?: Worktree
  startedAt?: number
  finishedAt?: number
  /** Only after the decision (revealed). */
  deliverable?: LabDeliverable
}

export interface LabRoundView extends Omit<LabRound, 'variants' | 'blindMap'> {
  variants: LabVariantView[]
  permissionMode: PermissionMode
  updatedAt: number
  /** Revealed only once the round is decided. */
  blindMap?: Record<string, string>
  /** A headless Claude selection is in progress. */
  claudeSelecting?: boolean
  selectionError?: string
  selectionCostUsd?: number
  /** The adopted harness was written to the project. */
  applied?: boolean
  reflection?: ReflectResult
  cleanedUp?: boolean
  cleanupErrors?: string[]
  error?: string
  /** Automatic modes: the pipeline timeline. */
  phases?: LabPhaseView[]
  /** Runs + proposer/composer calls + selection so far (USD). */
  totalCostUsd?: number
}

export interface AdoptResult {
  round: LabRoundView
  /** The base won: nothing to adopt, the project stays as it is. */
  unchanged: boolean
  snapshot?: HarnessSnapshot
  applied: boolean
}

/** A–Z, AA–AZ, BA… (same scheme as harness2's selection ids). */
export function anonId(index: number): string {
  let out = ''
  let n = index + 1
  while (n) {
    const rem = (n - 1) % 26
    n = Math.floor((n - 1) / 26)
    out = String.fromCharCode(65 + rem) + out
  }
  return out
}

/** The base run: `role` in the automatic modes (revealed after the decision), the fixed id in manual rounds. */
export function isBaseVariant(v: { id: string; role?: string }): boolean {
  return v.role === 'base' || v.id === BASE_VARIANT_ID
}

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [LAB.list]: (projectCwd: string) => LabRoundView[]
    [LAB.prepare]: (projectCwd: string) => LabPrepareInfo
    [LAB.create]: (input: CreateLabRoundInput) => LabRoundView
    [LAB.cancel]: (roundId: string) => LabRoundView
    [LAB.candidates]: (roundId: string) => BlindCandidate[]
    [LAB.choose]: (roundId: string, anonId: string, why: string) => LabRoundView
    [LAB.askClaude]: (roundId: string) => LabRoundView
    [LAB.adopt]: (roundId: string, apply: boolean, confirmExec?: string) => AdoptResult
    [LAB.adoptReview]: (roundId: string) => ExecReview
    [LAB.createReview]: (input: CreateLabRoundInput) => VariantExecReview[]
    [LAB.reflect]: (roundId: string) => ReflectResult
    [LAB.cleanup]: (roundId: string) => LabRoundView
    [LAB.remove]: (roundId: string) => void
  }

  interface IpcEventContract {
    [LAB.evRound]: LabRoundView
    [LAB.evRemoved]: { roundId: string }
  }
}
