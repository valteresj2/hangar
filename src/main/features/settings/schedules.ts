// Scheduled tasks: a prompt run in a folder on a cron expression.
// Persisted in <userData>/hangar-data/settings/schedules.json. Each run creates a new
// session and hands the prompt to the engine; the result arrives via `session:turn-ended`.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import cron, { type ScheduledTask as CronJob } from 'node-cron'
import type { Session } from '../../../shared/contracts'
import {
  SETTINGS,
  type CronCheck,
  type ScheduleRun,
  type ScheduledTask,
  type ScheduledTaskInput
} from '../../../shared/features/settings'
import { broadcast } from '../../core/broadcast'
import { bus } from '../../core/bus'
import { db, settings } from '../../core/store'
import { sendPrompt } from '../engine/api'

const HISTORY_LIMIT = 20

let tasks: ScheduledTask[] = []
const jobs = new Map<string, CronJob>()

function file(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'settings')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'schedules.json')
}

function load(): void {
  try {
    tasks = JSON.parse(readFileSync(file(), 'utf8')) as ScheduledTask[]
  } catch {
    tasks = []
  }
  // Runs still marked as running were cut short by an app exit.
  for (const t of tasks) {
    for (const r of t.history ?? []) {
      if (r.result === 'running') Object.assign(r, { result: 'error', error: 'O app foi fechado durante a execução.' })
    }
    if (t.lastResult === 'running') t.lastResult = 'error'
  }
}

function save(): void {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(tasks.map(({ nextRunAt: _, ...t }) => t), null, 2), 'utf8')
  renameSync(tmp, file())
  broadcast(SETTINGS.schedulesChanged)
}

function schedule(task: ScheduledTask): void {
  jobs.get(task.id)?.destroy()
  jobs.delete(task.id)
  if (!task.enabled || !cron.validate(task.cron)) return
  const job = cron.schedule(task.cron, () => void runTask(task.id, false), { name: `hangar-${task.id}`, noOverlap: true })
  jobs.set(task.id, job)
}

export function listSchedules(): ScheduledTask[] {
  return tasks.map((t) => ({ ...t, nextRunAt: jobs.get(t.id)?.getNextRun()?.getTime() }))
}

export function saveSchedule(input: ScheduledTaskInput): ScheduledTask {
  const check = validateCron(input.cron)
  if (!check.valid) throw new Error(check.error ?? 'Expressão cron inválida.')
  if (!input.name.trim()) throw new Error('Informe um nome.')
  if (!input.prompt.trim()) throw new Error('Informe o prompt.')
  if (!existsSync(input.cwd)) throw new Error('A pasta não existe.')
  const existing = input.id ? tasks.find((t) => t.id === input.id) : undefined
  const task: ScheduledTask = {
    ...existing,
    ...input,
    id: existing?.id ?? randomUUID(),
    name: input.name.trim(),
    cron: input.cron.trim(),
    model: input.model?.trim() || undefined
  }
  tasks = existing ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task]
  schedule(task)
  save()
  return task
}

export function deleteSchedule(id: string): boolean {
  jobs.get(id)?.destroy()
  jobs.delete(id)
  const before = tasks.length
  tasks = tasks.filter((t) => t.id !== id)
  if (tasks.length === before) return false
  save()
  return true
}

function record(taskId: string, run: ScheduleRun): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  const history = (task.history ?? []).filter((r) => r !== run && !(r.sessionId && r.sessionId === run.sessionId))
  task.history = [run, ...history].slice(0, HISTORY_LIMIT)
  task.lastRunAt = run.at
  task.lastResult = run.result
  save()
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export async function runTask(id: string, manual: boolean): Promise<ScheduleRun> {
  const task = tasks.find((t) => t.id === id)
  if (!task) throw new Error('Tarefa não encontrada.')
  const now = Date.now()
  if (!existsSync(task.cwd)) {
    const run: ScheduleRun = { at: now, result: 'error', manual, error: `Pasta não encontrada: ${task.cwd}` }
    record(id, run)
    return run
  }

  const prefs = settings().get()
  const session: Session = {
    id: randomUUID(),
    title: `${task.name} · ${formatDate(now)}`,
    cwd: task.cwd,
    pinned: false,
    archived: false,
    unread: true,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    model: task.model || prefs.defaultModel,
    effort: prefs.defaultEffort,
    permissionMode: task.permissionMode ?? prefs.defaultPermissionMode
  }
  db('sessions').put(session)

  const run: ScheduleRun = { at: now, sessionId: session.id, result: 'running', manual }
  record(id, run)
  try {
    await sendPrompt(session.id, task.prompt)
  } catch (err) {
    finishRun(session.id, 'error', err instanceof Error ? err.message : String(err))
  }
  return run
}

function finishRun(sessionId: string, result: 'success' | 'error', error?: string): void {
  for (const task of tasks) {
    const run = task.history?.find((r) => r.sessionId === sessionId)
    if (!run || run.result !== 'running') continue
    run.result = result
    if (error) run.error = error
    if (task.history?.[0] === run) task.lastResult = result
    save()
    return
  }
}

export function validateCron(expr: string): CronCheck {
  const trimmed = expr.trim()
  if (!trimmed) return { valid: false, error: 'Informe uma expressão cron.' }
  const detail = cron.validateDetailed(trimmed)
  if (!detail.valid) {
    return { valid: false, error: detail.errors.map((e) => `${e.field}: ${e.message}`).join('; ') || 'Expressão inválida.' }
  }
  const probe = cron.createTask(trimmed, () => undefined)
  try {
    return { valid: true, next: probe.getNextRuns(3).map((d) => d.getTime()) }
  } finally {
    void probe.destroy()
  }
}

const onTurnEnded = (e: { sessionId: string; result: 'success' | 'error' }) => finishRun(e.sessionId, e.result)

export function startSchedules(): void {
  load()
  for (const t of tasks) schedule(t)
  bus.on('session:turn-ended', onTurnEnded)
}

export function stopSchedules(): void {
  bus.off('session:turn-ended', onTurnEnded)
  for (const job of jobs.values()) void job.destroy()
  jobs.clear()
}
