// Typed wrappers over the lab:* channels and the rounds hook.
import { useEffect, useState } from 'react'
import type { ReflectResult } from '@shared/harness'
import {
  LAB,
  type AdoptResult,
  type BlindCandidate,
  type CreateLabRoundInput,
  type ExecReview,
  type LabPrepareInfo,
  type LabRoundView,
  type VariantExecReview
} from '@shared/features/lab'
import { bridge } from '../../core/api'

export const labApi = {
  list: (projectCwd: string) => bridge.invoke<LabRoundView[]>(LAB.list, projectCwd),
  prepare: (projectCwd: string) => bridge.invoke<LabPrepareInfo>(LAB.prepare, projectCwd),
  create: (input: CreateLabRoundInput) => bridge.invoke<LabRoundView>(LAB.create, input),
  cancel: (roundId: string) => bridge.invoke<LabRoundView>(LAB.cancel, roundId),
  candidates: (roundId: string) => bridge.invoke<BlindCandidate[]>(LAB.candidates, roundId),
  choose: (roundId: string, anonId: string, why: string) =>
    bridge.invoke<LabRoundView>(LAB.choose, roundId, anonId, why),
  askClaude: (roundId: string) => bridge.invoke<LabRoundView>(LAB.askClaude, roundId),
  adopt: (roundId: string, apply: boolean, confirmExec?: string) =>
    bridge.invoke<AdoptResult>(LAB.adopt, roundId, apply, confirmExec),
  adoptReview: (roundId: string) => bridge.invoke<ExecReview>(LAB.adoptReview, roundId),
  createReview: (input: CreateLabRoundInput) => bridge.invoke<VariantExecReview[]>(LAB.createReview, input),
  reflect: (roundId: string) => bridge.invoke<ReflectResult>(LAB.reflect, roundId),
  cleanup: (roundId: string) => bridge.invoke<LabRoundView>(LAB.cleanup, roundId),
  remove: (roundId: string) => bridge.invoke<void>(LAB.remove, roundId)
}

/** Strips Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/** Rounds of one project, newest first, kept live by `lab:event:round`. */
export function useLabRounds(projectCwd: string): LabRoundView[] | undefined {
  const [rounds, setRounds] = useState<LabRoundView[]>()
  useEffect(() => {
    let alive = true
    labApi.list(projectCwd).then(
      (r) => alive && setRounds(r),
      () => alive && setRounds([])
    )
    const offRound = bridge.on(LAB.evRound, (round: LabRoundView) => {
      if (!sameDir(round.projectCwd, projectCwd)) return
      setRounds((prev) => {
        const list = prev ?? []
        const i = list.findIndex((r) => r.id === round.id)
        if (i < 0) return [round, ...list]
        const next = [...list]
        next[i] = round
        return next
      })
    })
    const offRemoved = bridge.on(LAB.evRemoved, ({ roundId }: { roundId: string }) => {
      setRounds((prev) => prev?.filter((r) => r.id !== roundId))
    })
    return () => {
      alive = false
      offRound()
      offRemoved()
    }
  }, [projectCwd])
  return rounds
}

/** Re-renders every second while `active` (elapsed-time counters). */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}min ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}min`
}

export function formatCost(usd: number | undefined): string {
  return usd === undefined ? '—' : `US$ ${usd.toFixed(usd < 0.1 ? 4 : 2)}`
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
