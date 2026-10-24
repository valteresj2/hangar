// Task executions of a round: worktree + harness + session per variant, completion tracking,
// deliverable collection, the move to blind selection, and stopping a round (cancel / cost cap).
import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { Group, Session } from '../../../shared/contracts'
import { LAB_DIFF_LIMIT, LAB_GROUP_NAME, type LabDeliverable, type LabVariantView } from '../../../shared/features/lab'
import { db, settings } from '../../core/store'
import { interrupt, readTranscript, sendPrompt } from '../engine/api'
import { createWorktree } from '../git/api'
import { writeHarness } from '../harness/api'
import { diffTrees, snapshotTree } from './git'
import { totalCost } from './phases'
import type { RunEvidence } from './propose'
import { makeBlindMap } from './select'
import { allRounds, getRound, patchVariant, requireRound, updateRound, waitForRound, type LabRoundRecord } from './store'
import { condenseTrajectory, finalAnswerOf, outcomeOf } from './transcript'

export const ACTIVE = new Set(['preparing', 'running'])

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function shortTask(task: string, max = 40): string {
  const line = task.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function labGroupId(): string {
  const groups = db('groups').list()
  const existing = groups.find((g) => g.name === LAB_GROUP_NAME)
  if (existing) return existing.id
  const group: Group = { id: nanoid(), name: LAB_GROUP_NAME, order: groups.reduce((m, g) => Math.max(m, g.order), 0) + 1 }
  return db('groups').put(group).id
}

// git takes repository-wide locks while adding worktrees: create them one at a time.
let gitQueue: Promise<unknown> = Promise.resolve()
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(fn, fn)
  gitQueue = next.catch(() => undefined)
  return next
}

/** Worktree with the variant's harness, a baseline tree object and a session. Returns the session id. */
export async function prepareVariant(roundId: string, variantId: string): Promise<string> {
  const round = requireRound(roundId)
  const v = round.variants.find((x) => x.id === variantId)!
  const worktree = await withGitLock(() => createWorktree(round.projectCwd, `lab-${round.id}-${randomBytes(2).toString('hex')}`))
  patchVariant(roundId, variantId, { worktree, worktreePath: worktree.path })
  await writeHarness(worktree.path, v.tree)
  const baseline = await snapshotTree(worktree.path)
  const defaults = settings().get()
  const projectId = db('projects')
    .list()
    .find((p) => normalize(p.cwd) === normalize(round.projectCwd))?.id
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
    r.baselines = { ...r.baselines, [variantId]: baseline }
    const target = r.variants.find((x) => x.id === variantId)
    if (target) target.sessionId = session.id
  })
  return session.id
}

export async function startVariant(roundId: string, variantId: string, sessionId: string): Promise<void> {
  patchVariant(roundId, variantId, { status: 'running', startedAt: Date.now() })
  try {
    await sendPrompt(sessionId, requireRound(roundId).task)
  } catch (err) {
    patchVariant(roundId, variantId, { status: 'error', error: errorText(err), finishedAt: Date.now() })
  }
}

const terminal = (v: LabVariantView | undefined) => !v || v.status === 'done' || v.status === 'error'

/** Prepares, starts and awaits one variant (automatic modes). */
export async function runVariant(roundId: string, variantId: string): Promise<LabVariantView> {
  try {
    const sessionId = await prepareVariant(roundId, variantId)
    if (!ACTIVE.has(requireRound(roundId).status)) {
      patchVariant(roundId, variantId, { status: 'error', error: 'Cancelada.', finishedAt: Date.now() })
    } else {
      await startVariant(roundId, variantId, sessionId)
    }
  } catch (err) {
    patchVariant(roundId, variantId, { status: 'error', error: `Preparação falhou: ${errorText(err)}`, finishedAt: Date.now() })
  }
  const r = await waitForRound(roundId, (x) => terminal(x.variants.find((v) => v.id === variantId)) || !ACTIVE.has(x.status))
  return r.variants.find((v) => v.id === variantId)!
}

function findBySession(sessionId: string): { round: LabRoundRecord; variant: LabVariantView } | undefined {
  for (const round of allRounds()) {
    const variant = round.variants.find((v) => v.sessionId === sessionId)
    if (variant) return { round, variant }
  }
  return undefined
}

/** A variant's turn ended (bus `session:turn-ended`): record the outcome and its deliverable. */
export async function onTurnEnded(sessionId: string): Promise<void> {
  const hit = findBySession(sessionId)
  if (!hit || !ACTIVE.has(hit.round.status) || hit.variant.status !== 'running') return
  const entries = await readTranscript(sessionId)
  const outcome = outcomeOf(entries)
  // Collected right away: the pipeline hands this run to the next stage as evidence.
  const deliverable = await collect(hit.round, hit.variant).catch(
    (err): LabDeliverable => ({ finalAnswer: '', diffStat: '', diffExcerpt: '', diffTruncated: false, errors: [errorText(err)] })
  )
  updateRound(hit.round.id, (r) => {
    r.deliverables = { ...r.deliverables, [hit.variant.id]: deliverable }
    const v = r.variants.find((x) => x.id === hit.variant.id)
    if (!v) return
    Object.assign(v, {
      status: outcome.isError ? 'error' : 'done',
      error: outcome.isError ? outcome.errors[0] ?? 'A execução terminou com erro.' : undefined,
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      finishedAt: Date.now()
    })
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

export async function collect(round: LabRoundRecord, v: LabVariantView): Promise<LabDeliverable> {
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

/** A finished run as evidence for a proposer/composer stage. */
export async function runEvidence(round: LabRoundRecord, v: LabVariantView, label: string): Promise<RunEvidence> {
  const entries = v.sessionId ? await readTranscript(v.sessionId).catch(() => []) : []
  const d = round.deliverables?.[v.id]
  const redact = (text: string) =>
    v.worktree ? [v.worktree.path, v.worktree.path.replace(/\\/g, '/')].reduce((acc, n) => acc.split(n).join('<repo>'), text) : text
  return {
    label,
    status: v.status === 'done' ? 'delivered' : `error: ${v.error ?? 'unknown'}`,
    trajectory: redact(condenseTrajectory(entries, 40_000, true)),
    finalAnswer: d?.finalAnswer ?? '',
    changes: d ? [d.diffStat, d.diffExcerpt].filter(Boolean).join('\n\n') : '',
    costUsd: v.costUsd,
    durationMs: v.durationMs
  }
}

const finalizing = new Set<string>()

/** Collects missing deliverables and opens the blind selection over the pool (all done variants by default). */
export async function finalize(roundId: string): Promise<void> {
  const round = getRound(roundId)
  if (!round || round.status !== 'running' || finalizing.has(roundId)) return
  finalizing.add(roundId)
  try {
    const deliverables: Record<string, LabDeliverable> = { ...round.deliverables }
    for (const v of round.variants) {
      if (deliverables[v.id] || !v.worktree || !v.sessionId) continue
      deliverables[v.id] = await collect(round, v).catch((err) => ({
        finalAnswer: '',
        diffStat: '',
        diffExcerpt: '',
        diffTruncated: false,
        errors: [errorText(err)]
      }))
    }
    const pool = round.variants.filter((v) => v.inPool !== false && v.status === 'done' && deliverables[v.id]).map((v) => v.id)
    updateRound(roundId, (r) => {
      r.deliverables = deliverables
      if (pool.length) {
        r.blindMap = makeBlindMap(pool)
        r.status = 'selecting'
      } else {
        r.status = 'failed'
        r.error = 'Nenhuma execução do pool de seleção terminou com sucesso.'
      }
    })
  } finally {
    finalizing.delete(roundId)
  }
}

/** Manual rounds open the selection when every variant is terminal; automatic ones when their pipeline ends. */
export async function maybeFinalize(roundId: string): Promise<void> {
  const round = getRound(roundId)
  if (!round || round.status !== 'running') return
  if (round.mode === 'parallel' || round.mode === 'sequential') return
  if (round.variants.some((v) => v.status === 'pending' || v.status === 'running')) return
  await finalize(roundId)
}

// ── Stopping ───────────────────────────────────────────────────────────────

const controllers = new Map<string, AbortController>()

/** Abort signal of a round's proposer/composer calls. */
export function roundSignal(roundId: string): AbortSignal {
  let c = controllers.get(roundId)
  if (!c) {
    c = new AbortController()
    controllers.set(roundId, c)
  }
  return c.signal
}

export function releaseSignal(roundId: string): void {
  controllers.delete(roundId)
}

/** Ends an active round: aborts proposer calls, interrupts running sessions and marks what was pending. */
export async function stopRound(roundId: string, reason: string): Promise<void> {
  const round = getRound(roundId)
  if (!round || !ACTIVE.has(round.status)) return
  const sessions = round.variants.filter((v) => v.status === 'running' && v.sessionId).map((v) => v.sessionId!)
  updateRound(roundId, (r) => {
    r.status = 'cancelled'
    r.error = reason
    const now = Date.now()
    for (const v of r.variants) {
      if (v.status === 'pending' || v.status === 'running') Object.assign(v, { status: 'error', error: reason, finishedAt: now })
    }
    for (const s of r.stages ?? []) {
      if (s.status === 'pending' || s.status === 'running') Object.assign(s, { status: 'error', error: reason, finishedAt: now })
    }
  })
  controllers.get(roundId)?.abort()
  await Promise.all(sessions.map((id) => interrupt(id).catch(() => undefined)))
}

/** Called on every round change: stops a round whose spend went over its cap. */
export function enforceCap(roundId: string): void {
  const r = getRound(roundId)
  if (!r || !ACTIVE.has(r.status) || r.costCapUsd === undefined) return
  const spent = totalCost(r)
  if (spent > r.costCapUsd) {
    const usd = (x: number) => `US$ ${x.toFixed(x < 0.1 ? 4 : 2)}`
    void stopRound(roundId, `Teto de custo de ${usd(r.costCapUsd)} ultrapassado (gasto: ${usd(spent)}).`)
  }
}
