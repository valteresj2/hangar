// Automatic Lab modes (harness2 phase 3, recursion.run_parallel / run_sequential):
//   parallel k:   base → k INV + k DOM proposals → each run once → one composition → run → blind selection
//   sequential K: base → for t = 1..K: INV + DOM on the current checkpoint → run both → compose checkpoint t
//                 → run it (on-policy evidence for the next step) → blind selection over base + checkpoints
// Concept adapted from google-research/harness2 (Apache-2.0).
import { randomBytes } from 'node:crypto'
import type { HarnessTree, LabStage, LabVariantRole } from '../../../shared/harness'
import { listLessons, listSnapshots } from '../harness/api'
import { aggregateJob, composeRoundJob, proposeJob } from './prompts'
import { runStage, type CandidateEvidence, type RunEvidence } from './propose'
import { ACTIVE, errorText, finalize, releaseSignal, roundSignal, runEvidence, runVariant } from './runs'
import { getRound, requireRound, updateRound } from './store'

interface Ctx {
  roundId: string
  signal: AbortSignal
  baseTree: HarnessTree
  lessons: Awaited<ReturnType<typeof listLessons>>
  examples: Awaited<ReturnType<typeof listSnapshots>>
}

const alive = (ctx: Ctx) => !ctx.signal.aborted && ACTIVE.has(getRound(ctx.roundId)?.status ?? '')

/** Adds a run with a neutral name ("Execução N"); its role is revealed only after the decision. */
function addVariant(
  ctx: Ctx,
  v: { role: LabVariantRole; roleLabel: string; tree: HarnessTree; stageId?: string; step?: number; inPool: boolean }
): string {
  const id = `x${randomBytes(3).toString('hex')}`
  updateRound(ctx.roundId, (r) => {
    r.variants.push({ id, label: `Execução ${r.variants.length + 1}`, status: 'pending', ...v })
  })
  return id
}

async function runOne(ctx: Ctx, variantId: string, label: string): Promise<RunEvidence> {
  const v = await runVariant(ctx.roundId, variantId)
  return runEvidence(requireRound(ctx.roundId), v, label)
}

interface StageSpec {
  id: string
  dim: LabStage['dim']
  step?: number
  job: string
  currentTree: HarnessTree
  runs: RunEvidence[]
  candidates: CandidateEvidence[]
}

/** Runs one proposer/composer stage and records it on the round. */
async function stage(ctx: Ctx, spec: StageSpec): Promise<LabStage> {
  const round = requireRound(ctx.roundId)
  updateRound(ctx.roundId, (r) => {
    r.stages = [
      ...(r.stages ?? []),
      {
        id: spec.id,
        dim: spec.dim,
        step: spec.step,
        status: 'running',
        attempts: 0,
        startedAt: Date.now(),
        parentTree: spec.currentTree
      }
    ]
  })
  const out = await runStage({
    roundId: ctx.roundId,
    stageId: spec.id,
    job: spec.job,
    task: round.task,
    baseTree: ctx.baseTree,
    currentTree: spec.currentTree,
    runs: spec.runs,
    candidates: spec.candidates,
    lessons: ctx.lessons,
    examples: ctx.examples,
    model: round.proposerModel,
    signal: ctx.signal
  })
  const updated = updateRound(ctx.roundId, (r) => {
    const s = r.stages?.find((x) => x.id === spec.id)
    // stopRound may already have closed it (cancel / cost cap); only the cost is still worth recording.
    if (!s) return
    s.costUsd = out.costUsd
    s.durationMs = out.durationMs
    s.attempts = out.attempts
    if (s.status !== 'running') return
    Object.assign(s, {
      status: 'done',
      tree: out.tree,
      notes: out.notes,
      keptBase: out.keptBase,
      fellBack: out.fellBack,
      error: out.error,
      finishedAt: Date.now()
    })
  })
  return updated.stages!.find((x) => x.id === spec.id)!
}

function candidateOf(s: LabStage): CandidateEvidence {
  return { label: s.id, tree: s.tree ?? {}, notes: s.notes || s.error || '' }
}

function linkStage(ctx: Ctx, stageId: string, variantId: string): void {
  updateRound(ctx.roundId, (r) => {
    const s = r.stages?.find((x) => x.id === stageId)
    if (s) s.variantId = variantId
  })
}

async function parallel(ctx: Ctx, k: number): Promise<void> {
  const baseId = addVariant(ctx, { role: 'base', roleLabel: 'Base (harness atual)', tree: ctx.baseTree, inPool: true })
  const baseRun = await runOne(ctx, baseId, 'base')
  if (!alive(ctx)) return

  const specs = Array.from({ length: k }, (_, i) =>
    (['INV', 'DOM'] as const).map((dim) => ({ dim, index: i + 1 }))
  ).flat()
  const proposals = await Promise.all(
    specs.map(({ dim, index }) =>
      stage(ctx, {
        id: `${dim.toLowerCase()}${index}`,
        dim,
        job: proposeJob(dim, { k, index }),
        currentTree: ctx.baseTree,
        runs: [baseRun],
        candidates: []
      })
    )
  )
  if (!alive(ctx)) return

  const runs = await Promise.all(
    proposals.map(async (s, i) => {
      const variantId = addVariant(ctx, {
        role: s.dim === 'INV' ? 'inv' : 'dom',
        roleLabel: `${s.dim} ${specs[i].index}`,
        tree: s.tree ?? ctx.baseTree,
        stageId: s.id,
        inPool: true
      })
      linkStage(ctx, s.id, variantId)
      return runOne(ctx, variantId, s.id)
    })
  )
  if (!alive(ctx)) return

  const composed = await stage(ctx, {
    id: 'agg',
    dim: 'COMPOSE',
    job: aggregateJob(k),
    currentTree: ctx.baseTree,
    runs: [baseRun, ...runs],
    candidates: requireRound(ctx.roundId)
      .stages!.filter((s) => s.dim !== 'COMPOSE')
      .map(candidateOf)
  })
  if (!alive(ctx)) return
  const compId = addVariant(ctx, {
    role: 'compose',
    roleLabel: 'Composto',
    tree: composed.tree ?? ctx.baseTree,
    stageId: 'agg',
    inPool: true
  })
  linkStage(ctx, 'agg', compId)
  await runOne(ctx, compId, 'agg')
}

async function sequential(ctx: Ctx, K: number): Promise<void> {
  const baseId = addVariant(ctx, { role: 'base', roleLabel: 'Base (harness atual)', tree: ctx.baseTree, inPool: true })
  const runs: RunEvidence[] = [await runOne(ctx, baseId, 'base')]
  const candidates: CandidateEvidence[] = []
  let current = ctx.baseTree

  for (let t = 1; t <= K; t++) {
    if (!alive(ctx)) return
    const proposals = await Promise.all(
      (['INV', 'DOM'] as const).map((dim) =>
        stage(ctx, {
          id: `${dim.toLowerCase()}${t}`,
          dim,
          step: t,
          job: proposeJob(dim, { k: K, index: t, roundT: K > 1 ? t : undefined }),
          currentTree: current,
          runs: [...runs],
          candidates: [...candidates]
        })
      )
    )
    if (!alive(ctx)) return
    const newRuns = await Promise.all(
      proposals.map((s) => {
        // Proposal runs are evidence for the composer; only the base and the checkpoints go to blind selection.
        const variantId = addVariant(ctx, {
          role: s.dim === 'INV' ? 'inv' : 'dom',
          roleLabel: `${s.dim} · passo ${t}`,
          tree: s.tree ?? current,
          stageId: s.id,
          step: t,
          inPool: false
        })
        linkStage(ctx, s.id, variantId)
        return runOne(ctx, variantId, s.id)
      })
    )
    if (!alive(ctx)) return
    runs.push(...newRuns)
    candidates.push(...proposals.map(candidateOf))

    const ck = await stage(ctx, {
      id: `c${t}`,
      dim: 'COMPOSE',
      step: t,
      job: composeRoundJob(t, K),
      currentTree: current,
      runs: [...runs],
      candidates: [...candidates]
    })
    if (!alive(ctx)) return
    const ckTree = ck.tree ?? current
    const ckId = addVariant(ctx, {
      role: 'compose',
      roleLabel: `Checkpoint ${t}`,
      tree: ckTree,
      stageId: ck.id,
      step: t,
      inPool: true
    })
    linkStage(ctx, ck.id, ckId)
    runs.push(await runOne(ctx, ckId, `c${t}`))
    candidates.push(candidateOf(ck))
    current = ckTree
  }
}

/** Runs an automatic round to the blind selection. Errors end the round as failed. */
export async function runPipeline(roundId: string): Promise<void> {
  const round = requireRound(roundId)
  const ctx: Ctx = {
    roundId,
    signal: roundSignal(roundId),
    baseTree: round.baseTree ?? {},
    lessons: [],
    examples: []
  }
  try {
    ctx.lessons = await listLessons(round.projectCwd).catch(() => [])
    ctx.examples = (await listSnapshots(round.projectCwd).catch(() => [])).filter((s) => s.source === 'lab').slice(0, 3)
    updateRound(roundId, (r) => (r.status = 'running'))
    if (round.mode === 'parallel') await parallel(ctx, round.depth ?? 1)
    else await sequential(ctx, round.depth ?? 1)
    if (alive(ctx)) await finalize(roundId)
  } catch (err) {
    if (ACTIVE.has(getRound(roundId)?.status ?? '')) {
      updateRound(roundId, (r) => {
        r.status = 'failed'
        r.error = `O pipeline falhou: ${errorText(err)}`
      })
    }
  } finally {
    releaseSignal(roundId)
  }
}
