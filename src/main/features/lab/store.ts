// Lab rounds persisted in <userData>/hangar-data/lab/rounds.json (debounced, atomic writes).
// Every change broadcasts the renderer-safe view of the round (`lab:event:round`).
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAB, type LabDeliverable, type LabRoundView, type LabVariantView } from '../../../shared/features/lab'
import type { HarnessTree, LabStage } from '../../../shared/harness'
import { broadcast } from '../../core/broadcast'
import { phasesOf, totalCost } from './phases'

/** Main-side round: the view plus what must stay hidden until the decision. */
export interface LabRoundRecord extends LabRoundView {
  deliverables?: Record<string, LabDeliverable>
  /** Tree object of each variant's worktree right before the run (harness already written). */
  baselines?: Record<string, string>
  /** Automatic modes: the project's harness when the round was created. */
  baseTree?: HarnessTree
}

export function labDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'lab')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const rounds = new Map<string, LabRoundRecord>()
/** In-process notification of every round change ('changed', roundId); lets the pipeline await runs. */
export const roundEvents = new EventEmitter()
roundEvents.setMaxListeners(200)
let loaded = false
let timer: NodeJS.Timeout | undefined

function file(): string {
  return join(labDir(), 'rounds.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    for (const r of JSON.parse(readFileSync(file(), 'utf8')) as LabRoundRecord[]) rounds.set(r.id, r)
  } catch {
    // First run or unreadable file: start empty.
  }
}

export function flush(): void {
  clearTimeout(timer)
  timer = undefined
  if (!loaded) return
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify([...rounds.values()], null, 2), 'utf8')
  renameSync(tmp, file())
}

function scheduleSave(): void {
  clearTimeout(timer)
  timer = setTimeout(flush, 200)
}

/**
 * What the renderer may see: anonymity data and deliverables only after the decision. In the automatic
 * modes the variants keep neutral names and no harness, role or proposer notes until then either.
 */
export function toView(r: LabRoundRecord): LabRoundView {
  const { deliverables, baselines: _baselines, baseTree: _baseTree, blindMap, ...rest } = r
  const revealed = r.status === 'decided'
  const hide = !revealed && (r.mode === 'parallel' || r.mode === 'sequential')
  const neutralStage = (s: LabStage): LabStage => ({
    id: s.id,
    dim: s.dim,
    step: s.step,
    status: s.status,
    attempts: s.attempts,
    fellBack: s.fellBack,
    costUsd: s.costUsd,
    durationMs: s.durationMs,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt
  })
  const neutralVariant = (v: LabVariantView): LabVariantView => {
    const { role: _role, roleLabel: _roleLabel, stageId: _stageId, step: _step, inPool: _inPool, snapshotId: _snap, ...keep } = v
    return { ...keep, tree: {} }
  }
  return {
    ...rest,
    blindMap: revealed ? blindMap : undefined,
    totalCostUsd: totalCost(r),
    phases: phasesOf(r),
    stages: hide ? r.stages?.map(neutralStage) : r.stages,
    variants: r.variants.map((v) => {
      const view = { ...v, deliverable: revealed ? deliverables?.[v.id] : undefined }
      return hide ? neutralVariant(view) : view
    })
  }
}

export function allRounds(): LabRoundRecord[] {
  load()
  return [...rounds.values()]
}

export function getRound(id: string): LabRoundRecord | undefined {
  load()
  return rounds.get(id)
}

export function requireRound(id: string): LabRoundRecord {
  const r = getRound(id)
  if (!r) throw new Error('Rodada não encontrada.')
  return r
}

export function putRound(r: LabRoundRecord): LabRoundRecord {
  load()
  r.updatedAt = Date.now()
  rounds.set(r.id, r)
  scheduleSave()
  broadcast(LAB.evRound, toView(r))
  roundEvents.emit('changed', r.id)
  return r
}

/** Mutates a round in place and persists/broadcasts it. */
export function updateRound(id: string, fn: (r: LabRoundRecord) => void): LabRoundRecord {
  const r = requireRound(id)
  fn(r)
  return putRound(r)
}

export function patchVariant(roundId: string, variantId: string, patch: Partial<LabVariantView>): LabRoundRecord {
  return updateRound(roundId, (r) => {
    const v = r.variants.find((x) => x.id === variantId)
    if (v) Object.assign(v, patch)
  })
}

/** Resolves once `pred` holds for the round (checked now and after every change). */
export function waitForRound(roundId: string, pred: (r: LabRoundRecord) => boolean): Promise<LabRoundRecord> {
  return new Promise((resolve, reject) => {
    const check = (id: string) => {
      if (id !== roundId) return
      const r = rounds.get(roundId)
      if (!r) {
        roundEvents.off('changed', check)
        reject(new Error('Rodada não encontrada.'))
      } else if (pred(r)) {
        roundEvents.off('changed', check)
        resolve(r)
      }
    }
    roundEvents.on('changed', check)
    check(roundId)
  })
}

export function deleteRound(id: string): void {
  load()
  if (rounds.delete(id)) {
    scheduleSave()
    broadcast(LAB.evRemoved, { roundId: id })
    roundEvents.emit('changed', id)
  }
}
