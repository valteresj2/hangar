// Lab rounds persisted in <userData>/hangar-data/lab/rounds.json (debounced, atomic writes).
// Every change broadcasts the renderer-safe view of the round (`lab:event:round`).
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAB, type LabDeliverable, type LabRoundView } from '../../../shared/features/lab'
import { broadcast } from '../../core/broadcast'

/** Main-side round: the view plus what must stay hidden until the decision. */
export interface LabRoundRecord extends LabRoundView {
  deliverables?: Record<string, LabDeliverable>
  /** Tree object of each variant's worktree right before the run (harness already written). */
  baselines?: Record<string, string>
}

export function labDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'lab')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const rounds = new Map<string, LabRoundRecord>()
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

/** What the renderer may see: anonymity data and deliverables only after the decision. */
export function toView(r: LabRoundRecord): LabRoundView {
  const { deliverables, baselines: _baselines, blindMap, ...rest } = r
  const revealed = r.status === 'decided'
  return {
    ...rest,
    blindMap: revealed ? blindMap : undefined,
    variants: r.variants.map((v) => ({ ...v, deliverable: revealed ? deliverables?.[v.id] : undefined }))
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
  return r
}

/** Mutates a round in place and persists/broadcasts it. */
export function updateRound(id: string, fn: (r: LabRoundRecord) => void): LabRoundRecord {
  const r = requireRound(id)
  fn(r)
  return putRound(r)
}

export function deleteRound(id: string): void {
  load()
  if (rounds.delete(id)) {
    scheduleSave()
    broadcast(LAB.evRemoved, { roundId: id })
  }
}
