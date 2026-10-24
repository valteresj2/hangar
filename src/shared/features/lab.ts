// IPC channels and payload types for the "lab" feature. Owned by the lab agent.
import type { PermissionMode, Worktree } from '../contracts'
import type { HarnessSnapshot, HarnessTree, LabRound, LabVariant, ReflectResult } from '../harness'

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
  /** (roundId, apply: boolean) → AdoptResult */
  adopt: 'lab:adopt',
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
  /** Variants besides the base (1..MAX_LAB_VARIANTS). The base is always the project's current harness. */
  variants: LabVariantInput[]
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
