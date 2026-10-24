// Round lifecycle: preparing (worktrees + sessions) → running → selecting (blind) → decided,
// plus cancel, adopt, reflect, cleanup and the reconciliation done at startup.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type { Group, Session, Worktree } from '../../../shared/contracts'
import {
  BASE_VARIANT_ID,
  LAB_DIFF_LIMIT,
  LAB_GROUP_NAME,
  type AdoptResult,
  type BlindCandidate,
  type CreateLabRoundInput,
  type LabDeliverable,
  type LabPrepareInfo,
  type LabRoundView,
  type LabVariantView
} from '../../../shared/features/lab'
import { MAX_LAB_VARIANTS, type ReflectCandidate, type ReflectResult } from '../../../shared/harness'
import { db, settings } from '../../core/store'
import { closeSession, interrupt, readTranscript, sendPrompt } from '../engine/api'
import { createWorktree, isGitRepo, removeWorktree } from '../git/api'
import { createSnapshot, listSnapshots, readHarness, reflect, writeHarness } from '../harness/api'
import { diffTrees, git, hasHead, hasNonHarnessChanges, snapshotTree } from './git'
import { askClaude, makeBlindMap } from './select'
import { allRounds, deleteRound, getRound, putRound, requireRound, toView, updateRound, type LabRoundRecord } from './store'
import { condenseTrajectory, finalAnswerOf, outcomeOf } from './transcript'

const ACTIVE = new Set(['preparing', 'running'])

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function shortTask(task: string, max = 40): string {
  const line = task.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function listRounds(projectCwd: string): LabRoundView[] {
  const key = normalize(projectCwd)
  return allRounds()
    .filter((r) => normalize(r.projectCwd) === key)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toView)
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
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
  const task = input.task.trim()
  if (!task) throw new Error('Descreva a tarefa da rodada.')
  if (!input.variants.length || input.variants.length > MAX_LAB_VARIANTS) {
    throw new Error(`Use de 1 a ${MAX_LAB_VARIANTS} variantes além da base.`)
  }
  if (!(await isGitRepo(input.projectCwd))) {
    throw new Error('O Lab precisa de um repositório git: cada variante roda num worktree próprio.')
  }
  if (!(await hasHead(input.projectCwd))) throw new Error('O repositório ainda não tem commits; faça o primeiro commit antes.')

  const baseTree = await readHarness(input.projectCwd)
  const round: LabRoundRecord = {
    id: randomUUID().slice(0, 8),
    projectCwd: input.projectCwd,
    task,
    model: input.model || undefined,
    permissionMode: input.permissionMode ?? 'acceptEdits',
    status: 'preparing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    variants: [
      { id: BASE_VARIANT_ID, label: 'Base (harness atual)', tree: baseTree, status: 'pending' },
      ...input.variants.map((v, i) => ({
        id: `v${i + 1}`,
        label: v.label.trim() || `Variante ${i + 1}`,
        tree: v.tree,
        snapshotId: v.snapshotId,
        status: 'pending' as const
      }))
    ],
    baselines: {}
  }
  putRound(round)
  void launch(round.id)
  return toView(round)
}

function labGroupId(): string {
  const groups = db('groups').list()
  const existing = groups.find((g) => g.name === LAB_GROUP_NAME)
  if (existing) return existing.id
  const group: Group = { id: nanoid(), name: LAB_GROUP_NAME, order: groups.reduce((m, g) => Math.max(m, g.order), 0) + 1 }
  return db('groups').put(group).id
}

function patchVariant(roundId: string, variantId: string, patch: Partial<LabVariantView>): LabRoundRecord {
  return updateRound(roundId, (r) => {
    const v = r.variants.find((x) => x.id === variantId)
    if (v) Object.assign(v, patch)
  })
}

async function launch(roundId: string): Promise<void> {
  const round = requireRound(roundId)
  const projectId = db('projects')
    .list()
    .find((p) => normalize(p.cwd) === normalize(round.projectCwd))?.id
  const defaults = settings().get()
  const ready: { variantId: string; sessionId: string }[] = []

  // Worktrees one at a time (git takes repository-wide locks); the runs themselves go in parallel.
  for (const v of round.variants) {
    if (requireRound(roundId).status !== 'preparing') break
    try {
      const branch = `lab-${round.id}-${randomBytes(2).toString('hex')}`
      const worktree = await createWorktree(round.projectCwd, branch)
      patchVariant(roundId, v.id, { worktree, worktreePath: worktree.path })
      await writeHarness(worktree.path, v.tree)
      const baseline = await snapshotTree(worktree.path)
      const now = Date.now()
      const session: Session = {
        id: nanoid(),
        title: `Lab · ${shortTask(round.task)} · ${v.label}`,
        cwd: round.projectCwd,
        groupId: labGroupId(),
        pinned: false,
        archived: false,
        unread: false,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        model: round.model ?? defaults.defaultModel,
        effort: defaults.defaultEffort,
        permissionMode: round.permissionMode,
        worktree,
        ...(projectId ? { projectId } : {})
      }
      db('sessions').put(session)
      updateRound(roundId, (r) => {
        r.baselines = { ...r.baselines, [v.id]: baseline }
        const target = r.variants.find((x) => x.id === v.id)
        if (target) target.sessionId = session.id
      })
      ready.push({ variantId: v.id, sessionId: session.id })
    } catch (err) {
      patchVariant(roundId, v.id, { status: 'error', error: `Preparação falhou: ${errorText(err)}`, finishedAt: Date.now() })
    }
  }

  const current = requireRound(roundId)
  if (current.status !== 'preparing') return
  updateRound(roundId, (r) => (r.status = 'running'))
  await Promise.all(
    ready.map(async ({ variantId, sessionId }) => {
      patchVariant(roundId, variantId, { status: 'running', startedAt: Date.now() })
      try {
        await sendPrompt(sessionId, current.task)
      } catch (err) {
        patchVariant(roundId, variantId, { status: 'error', error: errorText(err), finishedAt: Date.now() })
      }
    })
  )
  await maybeFinalize(roundId)
}

function findBySession(sessionId: string): { round: LabRoundRecord; variant: LabVariantView } | undefined {
  for (const round of allRounds()) {
    const variant = round.variants.find((v) => v.sessionId === sessionId)
    if (variant) return { round, variant }
  }
  return undefined
}

/** A variant's turn ended (bus `session:turn-ended`). */
export async function onTurnEnded(sessionId: string): Promise<void> {
  const hit = findBySession(sessionId)
  if (!hit || !ACTIVE.has(hit.round.status) || hit.variant.status !== 'running') return
  const outcome = outcomeOf(await readTranscript(sessionId))
  patchVariant(hit.round.id, hit.variant.id, {
    status: outcome.isError ? 'error' : 'done',
    error: outcome.isError ? outcome.errors[0] ?? 'A execução terminou com erro.' : undefined,
    costUsd: outcome.costUsd,
    durationMs: outcome.durationMs,
    finishedAt: Date.now()
  })
  await maybeFinalize(hit.round.id)
}

/** A running variant's session disappeared (deleted by the user). */
export function onSessionsChanged(): void {
  for (const round of allRounds()) {
    if (!ACTIVE.has(round.status)) continue
    for (const v of round.variants) {
      if (v.status === 'running' && v.sessionId && !db('sessions').get(v.sessionId)) {
        patchVariant(round.id, v.id, { status: 'error', error: 'A sessão da variante foi excluída.', finishedAt: Date.now() })
        void maybeFinalize(round.id)
      }
    }
  }
}

const finalizing = new Set<string>()

/** When every variant is terminal: collect deliverables and open the blind selection. */
async function maybeFinalize(roundId: string): Promise<void> {
  const round = getRound(roundId)
  if (!round || round.status !== 'running' || finalizing.has(roundId)) return
  if (round.variants.some((v) => v.status === 'pending' || v.status === 'running')) return
  finalizing.add(roundId)
  try {
    const deliverables: Record<string, LabDeliverable> = {}
    for (const v of round.variants) {
      if (!v.worktree || !v.sessionId) continue
      try {
        deliverables[v.id] = await collect(round, v)
      } catch (err) {
        deliverables[v.id] = { finalAnswer: '', diffStat: '', diffExcerpt: '', diffTruncated: false, errors: [errorText(err)] }
      }
    }
    const delivered = round.variants.filter((v) => v.status === 'done' && deliverables[v.id]).map((v) => v.id)
    updateRound(roundId, (r) => {
      r.deliverables = deliverables
      if (delivered.length) {
        r.blindMap = makeBlindMap(delivered)
        r.status = 'selecting'
      } else {
        r.status = 'failed'
        r.error = 'Nenhuma variante terminou com sucesso.'
      }
    })
  } finally {
    finalizing.delete(roundId)
  }
}

async function collect(round: LabRoundRecord, v: LabVariantView): Promise<LabDeliverable> {
  const entries = await readTranscript(v.sessionId!)
  const wt = v.worktree!
  const baseline = round.baselines?.[v.id]
  let diff = { stat: '', excerpt: '', truncated: false }
  if (baseline) diff = await diffTrees(wt.path, baseline, await snapshotTree(wt.path), LAB_DIFF_LIMIT)
  // Worktree paths name the branch; keep them out of what the selector reads.
  const redact = (text: string) =>
    [wt.path, wt.path.replace(/\\/g, '/'), wt.branch].reduce((acc, needle) => acc.split(needle).join('<repo>'), text)
  return {
    finalAnswer: redact(finalAnswerOf(entries)),
    diffStat: redact(diff.stat),
    diffExcerpt: redact(diff.excerpt),
    diffTruncated: diff.truncated,
    errors: outcomeOf(entries).errors.map(redact)
  }
}

export async function cancelRound(roundId: string): Promise<LabRoundView> {
  const round = requireRound(roundId)
  if (!ACTIVE.has(round.status)) return toView(round)
  const sessions = round.variants.filter((v) => v.status === 'running' && v.sessionId).map((v) => v.sessionId!)
  updateRound(roundId, (r) => {
    r.status = 'cancelled'
    for (const v of r.variants) {
      if (v.status === 'pending' || v.status === 'running') {
        v.status = 'error'
        v.error = 'Cancelada.'
        v.finishedAt = Date.now()
      }
    }
  })
  await Promise.all(sessions.map((id) => interrupt(id).catch(() => undefined)))
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

export async function adopt(roundId: string, apply: boolean): Promise<AdoptResult> {
  const round = requireRound(roundId)
  const winner = winnerOf(round)
  if (winner.id === BASE_VARIANT_ID) return { round: toView(round), unchanged: true, applied: false }
  const by = round.selection!.by === 'user' ? 'você' : 'Claude'
  const snapshot = await createSnapshot(
    round.projectCwd,
    `Lab · ${shortTask(round.task)} · ${winner.label}`,
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
  const base = round.variants.find((v) => v.id === BASE_VARIANT_ID)!
  const candidates: ReflectCandidate[] = []
  for (const v of round.variants) {
    if (!v.sessionId) continue
    const d = round.deliverables?.[v.id]
    const entries = await readTranscript(v.sessionId).catch(() => [])
    candidates.push({
      label: v.label,
      tree: v.tree,
      trajectory: condenseTrajectory(entries),
      changes: d ? [d.diffStat, d.diffExcerpt.slice(0, 6000)].filter(Boolean).join('\n\n') || '(no file changes)' : '(not collected)',
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
  throw lastError ?? new Error(`Não foi possível remover ${wt.path} (pasta em uso).`)
}

export async function cleanup(roundId: string): Promise<LabRoundView> {
  if (ACTIVE.has(requireRound(roundId).status)) await cancelRound(roundId)
  const round = requireRound(roundId)
  const errors: string[] = []
  for (const v of round.variants) {
    if (!v.sessionId) continue
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
          : { status: 'error', error: 'Interrompida: o app foi fechado antes do fim da execução.', finishedAt: Date.now() }
      )
    }
    await maybeFinalize(round.id)
  }
}

