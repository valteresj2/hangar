// Round lifecycle: preparing (worktrees + sessions) → running → selecting (blind) → decided,
// plus cancel, adopt, reflect, cleanup and the reconciliation done at startup. Manual rounds run
// their variants side by side; automatic ones (parallel / sequential) are driven by pipeline.ts.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Worktree } from '../../../shared/contracts'
import {
  BASE_VARIANT_ID,
  isBaseVariant,
  type AdoptResult,
  type BlindCandidate,
  type CreateLabRoundInput,
  type ExecReview,
  type LabPrepareInfo,
  type LabRoundView,
  type LabVariantView,
  type VariantExecReview
} from '../../../shared/features/lab'
import {
  LAB_PARALLEL_MAX,
  LAB_SEQUENTIAL_MAX,
  MAX_LAB_VARIANTS,
  type ReflectCandidate,
  type ReflectResult
} from '../../../shared/harness'
import { db } from '../../core/store'
import { closeSession, interrupt, readTranscript } from '../engine/api'
import { isGitRepo, removeWorktree } from '../git/api'
import { createSnapshot, listSnapshots, readHarness, reflect, writeHarness } from '../harness/api'
import { git, hasHead, hasNonHarnessChanges } from './git'
import { runPipeline } from './pipeline'
import {
  ACTIVE,
  errorText,
  finalize,
  maybeFinalize,
  normalize,
  prepareVariant,
  shortTask,
  startVariant,
  stopRound
} from './runs'
import { askClaude } from './select'
import {
  allRounds,
  deleteRound,
  labDir,
  patchVariant,
  putRound,
  requireRound,
  toView,
  updateRound,
  type LabRoundRecord
} from './store'
import { condenseTrajectory, outcomeOf } from './transcript'
import { execReview } from './exec'
import { assertCanCreateSessions } from '../platform/api'

export function listRounds(projectCwd: string): LabRoundView[] {
  const key = normalize(projectCwd)
  return allRounds()
    .filter((r) => normalize(r.projectCwd) === key)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toView)
}

export async function prepare(projectCwd: string): Promise<LabPrepareInfo> {
  const isRepo = await isGitRepo(projectCwd)
  const [baseTree, snapshots] = await Promise.all([
    readHarness(projectCwd).catch(() => ({})),
    listSnapshots(projectCwd).catch(() => [])
  ])
  if (!isRepo) return { isRepo, hasHead: false, dirty: false, baseTree, snapshots }
  const [head, dirty] = await Promise.all([hasHead(projectCwd), hasNonHarnessChanges(projectCwd).catch(() => false)])
  return { isRepo, hasHead: head, dirty, baseTree, snapshots }
}

// ── Creating and running ───────────────────────────────────────────────────

export async function createRound(input: CreateLabRoundInput): Promise<LabRoundView> {
  // Mode "required" without a platform connection: refuse before any worktree or session exists.
  assertCanCreateSessions()
  const task = input.task.trim()
  if (!task) throw new Error('Descreva a tarefa da rodada.')
  const mode = input.mode ?? 'manual'
  const depth = input.depth ?? 1
  if (mode === 'manual' && (!input.variants.length || input.variants.length > MAX_LAB_VARIANTS)) {
    throw new Error(`Use de 1 a ${MAX_LAB_VARIANTS} variantes além da base.`)
  }
  if (mode === 'parallel' && (depth < 1 || depth > LAB_PARALLEL_MAX))
    throw new Error(`k deve ficar entre 1 e ${LAB_PARALLEL_MAX}.`)
  if (mode === 'sequential' && (depth < 1 || depth > LAB_SEQUENTIAL_MAX))
    throw new Error(`K deve ficar entre 1 e ${LAB_SEQUENTIAL_MAX}.`)
  if (input.costCapUsd !== undefined && !(input.costCapUsd > 0))
    throw new Error('O teto de custo deve ser maior que zero.')
  if (!(await isGitRepo(input.projectCwd))) {
    throw new Error('O Lab precisa de um repositório git: cada variante roda num worktree próprio.')
  }
  if (!(await hasHead(input.projectCwd)))
    throw new Error('O repositório ainda não tem commits; faça o primeiro commit antes.')

  const baseTree = await readHarness(input.projectCwd)
  if (mode === 'manual') {
    // Variants that change hooks/scripts run that code inside the round's worktrees: the user must have seen it.
    const expected = combinedFingerprint(
      input.variants.map((v) => ({ label: v.label, ...execReview(baseTree, v.tree) }))
    )
    if (expected && input.confirmExec !== expected) {
      throw new Error('Variantes que alteram hooks ou scripts precisam de confirmação explícita antes de rodar.')
    }
  }
  const common = {
    id: randomUUID().slice(0, 8),
    projectCwd: input.projectCwd,
    task,
    model: input.model || undefined,
    permissionMode: input.permissionMode ?? 'acceptEdits',
    status: 'preparing' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    costCapUsd: input.costCapUsd,
    baselines: {}
  }
  const round: LabRoundRecord =
    mode === 'manual'
      ? {
          ...common,
          mode: 'manual',
          variants: [
            { id: BASE_VARIANT_ID, label: 'Base (harness atual)', tree: baseTree, status: 'pending', role: 'base' },
            ...input.variants.map((v, i) => ({
              id: `v${i + 1}`,
              label: v.label.trim() || `Variante ${i + 1}`,
              tree: v.tree,
              snapshotId: v.snapshotId,
              status: 'pending' as const,
              role: 'manual' as const
            }))
          ]
        }
      : { ...common, mode, depth, proposerModel: input.proposerModel || undefined, variants: [], stages: [], baseTree }
  putRound(round)
  void (mode === 'manual' ? launchManual(round.id) : runPipeline(round.id))
  return toView(round)
}

async function launchManual(roundId: string): Promise<void> {
  const round = requireRound(roundId)
  const ready: { variantId: string; sessionId: string }[] = []
  for (const v of round.variants) {
    if (requireRound(roundId).status !== 'preparing') break
    try {
      ready.push({ variantId: v.id, sessionId: await prepareVariant(roundId, v.id) })
    } catch (err) {
      patchVariant(roundId, v.id, {
        status: 'error',
        error: `Preparação falhou: ${errorText(err)}`,
        finishedAt: Date.now()
      })
    }
  }
  if (requireRound(roundId).status !== 'preparing') return
  updateRound(roundId, (r) => (r.status = 'running'))
  await Promise.all(ready.map(({ variantId, sessionId }) => startVariant(roundId, variantId, sessionId)))
  await maybeFinalize(roundId)
}

export async function cancelRound(roundId: string): Promise<LabRoundView> {
  await stopRound(roundId, 'Cancelada.')
  return toView(requireRound(roundId))
}

// ── Blind selection ────────────────────────────────────────────────────────

export function blindCandidates(roundId: string): BlindCandidate[] {
  const round = requireRound(roundId)
  if (round.status !== 'selecting' || !round.blindMap) throw new Error('A rodada não está na fase de seleção.')
  return Object.entries(round.blindMap)
    .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .map(([anonId, variantId]) => ({ anonId, ...round.deliverables![variantId] }))
}

export function chooseCandidate(roundId: string, anonId: string, why: string): LabRoundView {
  const round = requireRound(roundId)
  const variantId = round.status === 'selecting' ? round.blindMap?.[anonId] : undefined
  if (!variantId) throw new Error('Candidato inválido para esta rodada.')
  return toView(
    updateRound(roundId, (r) => {
      r.selection = { by: 'user', anonId, variantId, why: why.trim() }
      r.status = 'decided'
      r.selectionError = undefined
    })
  )
}

export async function askClaudeToChoose(roundId: string): Promise<LabRoundView> {
  const round = requireRound(roundId)
  if (round.claudeSelecting) return toView(round)
  const candidates = blindCandidates(roundId)
  updateRound(roundId, (r) => {
    r.claudeSelecting = true
    r.selectionError = undefined
  })
  try {
    const choice = await askClaude(round.task, candidates)
    updateRound(roundId, (r) => {
      if (r.status !== 'selecting') return
      r.selection = { by: 'claude', anonId: choice.anonId, variantId: r.blindMap![choice.anonId], why: choice.why }
      r.selectionCostUsd = choice.costUsd
      r.status = 'decided'
    })
  } catch (err) {
    updateRound(roundId, (r) => (r.selectionError = errorText(err)))
  } finally {
    updateRound(roundId, (r) => (r.claudeSelecting = false))
  }
  return toView(requireRound(roundId))
}

// ── After the decision ─────────────────────────────────────────────────────

function winnerOf(round: LabRoundRecord): LabVariantView {
  const id = round.status === 'decided' ? round.selection?.variantId : undefined
  const winner = round.variants.find((v) => v.id === id)
  if (!winner) throw new Error('A rodada ainda não tem um vencedor.')
  return winner
}

const nameOf = (v: LabVariantView) => v.roleLabel ?? v.label

/** Manual-round confirmation token: the non-empty variant fingerprints, in variant order. */
function combinedFingerprint(reviews: VariantExecReview[]): string {
  return reviews
    .map((r) => r.fingerprint)
    .filter(Boolean)
    .join(',')
}

/** Executable changes of each manual variant against the project's current harness. */
export async function createReview(input: CreateLabRoundInput): Promise<VariantExecReview[]> {
  const baseTree = await readHarness(input.projectCwd)
  return input.variants.map((v, i) => ({
    label: v.label.trim() || `Variante ${i + 1}`,
    ...execReview(baseTree, v.tree)
  }))
}

/** What applying the winner would change in what runs on this machine (vs the project's harness now). */
export async function adoptReview(roundId: string): Promise<ExecReview> {
  const round = requireRound(roundId)
  const winner = winnerOf(round)
  if (isBaseVariant(winner)) return { changes: [], fingerprint: '' }
  return execReview(await readHarness(round.projectCwd), winner.tree)
}

export async function adopt(roundId: string, apply: boolean, confirmExec?: string): Promise<AdoptResult> {
  const round = requireRound(roundId)
  const winner = winnerOf(round)
  if (isBaseVariant(winner)) return { round: toView(round), unchanged: true, applied: false }
  if (apply) {
    // Writing hooks/scripts into the project is code execution: only with the exact list the user confirmed.
    const review = execReview(await readHarness(round.projectCwd), winner.tree)
    if (review.fingerprint && confirmExec !== review.fingerprint) {
      throw new Error(
        'Este harness altera hooks ou scripts executáveis: confirme a lista de mudanças antes de aplicar.'
      )
    }
  }
  const by = round.selection!.by === 'user' ? 'você' : 'Claude'
  const snapshot = await createSnapshot(
    round.projectCwd,
    `Lab · ${shortTask(round.task)} · ${nameOf(winner)}`,
    'lab',
    winner.tree,
    `Rodada ${round.id} do Harness Lab, escolhido por ${by}. ${round.selection!.why}`.trim()
  )
  if (apply) await writeHarness(round.projectCwd, winner.tree)
  const updated = updateRound(roundId, (r) => {
    r.adoptedSnapshotId = snapshot.id
    if (apply) r.applied = true
  })
  return { round: toView(updated), unchanged: false, snapshot, applied: apply }
}

export async function reflectRound(roundId: string): Promise<ReflectResult> {
  const round = requireRound(roundId)
  const winner = winnerOf(round)
  const base = round.variants.find(isBaseVariant)!
  const candidates: ReflectCandidate[] = []
  for (const v of round.variants) {
    if (!v.sessionId) continue
    const d = round.deliverables?.[v.id]
    const entries = await readTranscript(v.sessionId).catch(() => [])
    const stage = round.stages?.find((s) => s.id === v.stageId)
    const changes = d
      ? [d.diffStat, d.diffExcerpt.slice(0, 6000)].filter(Boolean).join('\n\n') || '(no file changes)'
      : '(not collected)'
    candidates.push({
      label: nameOf(v),
      tree: v.tree,
      // The proposer's own reasoning helps the reflector attribute effects to edits.
      trajectory:
        (stage?.notes ? `PROPOSER NOTES (${stage.id}):\n${stage.notes}\n\n` : '') + condenseTrajectory(entries),
      changes,
      costUsd: v.costUsd,
      durationMs: v.durationMs,
      adopted: v.id === winner.id
    })
  }
  const result = await reflect({
    projectCwd: round.projectCwd,
    task: round.task,
    baseTree: base.tree,
    candidates,
    source: { kind: 'lab', roundId }
  })
  updateRound(roundId, (r) => {
    r.reflectionId = result.reflection.id
    r.reflection = result
  })
  return result
}

/**
 * Archives a session; archiving releases what it holds open inside its worktree (Claude Code process,
 * terminals, dev servers), which on Windows would keep the folder locked. The transcript is kept.
 */
async function archiveAndRelease(sessionId: string): Promise<void> {
  await closeSession(sessionId)
  db('sessions').patch(sessionId, { archived: true, status: 'idle', updatedAt: Date.now() })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Removes a worktree, retrying while the processes that had it as cwd finish exiting. */
async function removeWorktreeWithRetry(wt: Worktree, projectCwd: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await removeWorktree(wt)
      if (!existsSync(wt.path)) {
        // removeWorktree only drops hangar/* branches; lab branches go too when they hold no unmerged work.
        await git(projectCwd, ['branch', '-d', wt.branch]).catch(() => undefined)
        return
      }
    } catch (err) {
      lastError = err
    }
    await sleep(1000)
  }
  throw lastError instanceof Error ? lastError : new Error(`Não foi possível remover ${wt.path} (pasta em uso).`)
}

export async function cleanup(roundId: string): Promise<LabRoundView> {
  if (ACTIVE.has(requireRound(roundId).status)) await cancelRound(roundId)
  const round = requireRound(roundId)
  const errors: string[] = []
  for (const v of round.variants) {
    if (!v.sessionId || !db('sessions').get(v.sessionId)) continue
    await interrupt(v.sessionId).catch(() => undefined)
    await archiveAndRelease(v.sessionId)
  }
  for (const v of round.variants) {
    if (!v.worktree) continue
    try {
      await removeWorktreeWithRetry(v.worktree, round.projectCwd)
    } catch (err) {
      errors.push(`${v.label}: ${errorText(err)}`)
    }
  }
  // Proposer evidence directories: notes and trees are already stored on the round.
  await rm(join(labDir(), 'ctx', roundId), { recursive: true, force: true }).catch(() => undefined)
  return toView(
    updateRound(roundId, (r) => {
      r.cleanedUp = errors.length === 0
      r.cleanupErrors = errors.length ? errors : undefined
    })
  )
}

export function removeRound(roundId: string): void {
  const round = requireRound(roundId)
  if (ACTIVE.has(round.status)) throw new Error('Cancele a rodada antes de excluí-la.')
  if (!round.cleanedUp && round.variants.some((v) => v.worktree)) {
    throw new Error('Limpe a rodada (worktrees e sessões) antes de excluí-la.')
  }
  deleteRound(roundId)
}

// ── Startup ────────────────────────────────────────────────────────────────

/** Rounds left mid-flight by a previous run of the app. */
export async function reconcile(): Promise<void> {
  for (const round of allRounds()) {
    if (round.claudeSelecting) {
      updateRound(round.id, (r) => {
        r.claudeSelecting = false
        r.selectionError = 'A escolha do Claude foi interrompida quando o app fechou.'
      })
    }
    if (round.status === 'preparing') {
      updateRound(round.id, (r) => {
        r.status = 'failed'
        r.error = 'O app foi fechado durante a preparação.'
      })
      continue
    }
    if (round.status !== 'running') continue
    const auto = round.mode === 'parallel' || round.mode === 'sequential'
    for (const v of round.variants) {
      if (v.status !== 'running' && v.status !== 'pending') continue
      const session = v.sessionId ? db('sessions').get(v.sessionId) : undefined
      if (!session) {
        patchVariant(round.id, v.id, { status: 'error', error: 'Sessão não encontrada.', finishedAt: Date.now() })
        continue
      }
      const outcome = outcomeOf(await readTranscript(session.id).catch(() => []))
      patchVariant(
        round.id,
        v.id,
        outcome.finished
          ? {
              status: outcome.isError ? 'error' : 'done',
              error: outcome.isError ? outcome.errors[0] : undefined,
              costUsd: outcome.costUsd,
              durationMs: outcome.durationMs,
              finishedAt: Date.now()
            }
          : {
              status: 'error',
              error: 'Interrompida: o app foi fechado antes do fim da execução.',
              finishedAt: Date.now()
            }
      )
    }
    if (!auto) {
      await maybeFinalize(round.id)
      continue
    }
    // A pipeline cannot resume mid-way; what already ran can still be compared blind.
    const finishedPipeline = round.variants.some((v) => v.role === 'base' && v.status === 'done')
    updateRound(round.id, (r) => {
      for (const s of r.stages ?? []) {
        if (s.status === 'running' || s.status === 'pending')
          Object.assign(s, { status: 'error', error: 'Interrompida: o app foi fechado.' })
      }
      if (!finishedPipeline) {
        r.status = 'failed'
        r.error = 'O app foi fechado no meio do pipeline automático.'
      }
    })
    if (finishedPipeline) {
      updateRound(
        round.id,
        (r) => (r.error = 'O app foi fechado no meio do pipeline; a seleção usa as execuções concluídas.')
      )
      await finalize(round.id)
    }
  }
}
