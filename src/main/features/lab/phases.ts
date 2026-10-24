// Pipeline timeline of an automatic round, aggregated per phase so it never says which run is
// the base or the composite before the blind selection.
import type { LabPhaseView } from '../../../shared/features/lab'
import type { LabStage, LabVariant } from '../../../shared/harness'

type Item = { status: 'pending' | 'running' | 'done' | 'error'; costUsd?: number; durationMs?: number; startedAt?: number; finishedAt?: number }

function phase(key: string, title: string, items: Item[], planned: number, extra: Partial<LabPhaseView> = {}): LabPhaseView {
  const total = Math.max(planned, items.length)
  const finished = items.filter((i) => i.status === 'done' || i.status === 'error').length
  const running = items.some((i) => i.status === 'running')
  let status: LabPhaseView['status'] = 'pending'
  if (running || (finished > 0 && finished < total)) status = 'running'
  else if (total > 0 && finished === total) status = items.every((i) => i.status === 'error') ? 'error' : 'done'
  const costs = items.map((i) => i.costUsd).filter((c): c is number => c !== undefined)
  // Phase time: from the first start to the last finish (items in a phase run in parallel).
  const starts = items.map((i) => i.startedAt).filter((t): t is number => !!t)
  const ends = items.map((i) => i.finishedAt).filter((t): t is number => !!t)
  const durationMs = starts.length && ends.length && finished === total ? Math.max(...ends) - Math.min(...starts) : undefined
  return {
    key,
    title,
    status,
    total,
    finished,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
    durationMs,
    ...extra
  }
}

function stageExtra(stages: LabStage[]): Partial<LabPhaseView> {
  return {
    retries: stages.filter((s) => s.attempts > 1).length,
    fallbacks: stages.filter((s) => s.fellBack).length
  }
}

export function phasesOf(r: {
  mode?: string
  depth?: number
  status: string
  variants: LabVariant[]
  stages?: LabStage[]
  selectionCostUsd?: number
}): LabPhaseView[] | undefined {
  if (r.mode !== 'parallel' && r.mode !== 'sequential') return undefined
  const k = r.depth ?? 1
  const stages = r.stages ?? []
  const runs = (pred: (v: LabVariant) => boolean) => r.variants.filter(pred)
  const out: LabPhaseView[] = [phase('base', 'Execução da base', runs((v) => v.role === 'base'), 1)]

  if (r.mode === 'parallel') {
    const proposals = stages.filter((s) => s.dim !== 'COMPOSE')
    const composer = stages.filter((s) => s.dim === 'COMPOSE')
    out.push(
      phase('propose', 'Propostas INV/DOM', proposals, 2 * k, stageExtra(proposals)),
      phase('runs', 'Execuções das propostas', runs((v) => v.role === 'inv' || v.role === 'dom'), 2 * k),
      phase('compose', 'Composição', composer, 1, stageExtra(composer)),
      phase('compose-run', 'Execução do composto', runs((v) => v.role === 'compose'), 1)
    )
  } else {
    for (let t = 1; t <= k; t++) {
      const proposals = stages.filter((s) => s.step === t && s.dim !== 'COMPOSE')
      const composer = stages.filter((s) => s.step === t && s.dim === 'COMPOSE')
      out.push(
        phase(`propose-${t}`, `Passo ${t} · propostas INV/DOM`, proposals, 2, stageExtra(proposals)),
        phase(`runs-${t}`, `Passo ${t} · execuções`, runs((v) => v.step === t && (v.role === 'inv' || v.role === 'dom')), 2),
        phase(`compose-${t}`, `Passo ${t} · composição`, composer, 1, stageExtra(composer)),
        phase(`ckrun-${t}`, `Passo ${t} · execução do checkpoint`, runs((v) => v.step === t && v.role === 'compose'), 1)
      )
    }
  }

  const selecting = r.status === 'selecting' ? 'running' : r.status === 'decided' ? 'done' : 'pending'
  out.push({
    key: 'select',
    title: 'Seleção cega',
    status: selecting,
    total: 1,
    finished: selecting === 'done' ? 1 : 0,
    costUsd: r.selectionCostUsd
  })
  return out
}

export function totalCost(r: { variants: LabVariant[]; stages?: LabStage[]; selectionCostUsd?: number }): number {
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  return sum(r.variants.map((v) => v.costUsd)) + sum((r.stages ?? []).map((s) => s.costUsd)) + (r.selectionCostUsd ?? 0)
}
