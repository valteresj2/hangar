// Following a platform task from the session that started it, until the end. When a session's assign_task answers with
// a task, the session follows it: the card in the session shows the plan, the timeline, the cost and, at the end, the
// result; tasks it hands off to a colleague are followed too. When the task ends or stops for a person, the session
// gets a message and answers it (turn the wake-up off per task in the card). Details come from GET /api/tasks/{id}
// (app token, platform 0.58.2 or newer), refreshed on each task.updated event and every minute while open.
//
// File in <userData>/hangar-data/workspace/:
//   follow.json  { v, tasks: { "<id>": { sessionId, employee, wake, woken: ["done", "req:12", …] } } }
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TASK_DONE,
  TASK_WAITING,
  WORKSPACE,
  type FollowChange,
  type FollowedTask
} from '../../../shared/features/workspace'
import { broadcast } from '../../core/broadcast'
import { db } from '../../core/store'
import { noteSession, sendPrompt, sessionState } from '../engine/api'
import { platformGet, PlatformError } from '../platform/api'
import { parseFollowedTask, taskIdFromToolResult } from './parse'

const REFRESH_MS = 60_000 // a fallback while the event stream is down
const DEBOUNCE_MS = 1_500
const WAKE_RETRY_MS = 15_000 // the session is mid-turn: try again
const RESULT_MAX = 8_000
/** The platform MCP tools whose answer is a task this session should follow. */
const STARTS = /(?:^|__)(assign_task)$/

interface Entry {
  sessionId: string
  employee: string
  wake: boolean
  woken: string[]
}

let entries: Record<string, Entry> = {}
const snapshots = new Map<number, FollowedTask>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let poll: ReturnType<typeof setInterval> | undefined
let nameOf: (slug: string) => string | undefined = () => undefined

// ---------------------------------------------------------------- disk

function file(): string {
  const d = join(app.getPath('userData'), 'hangar-data', 'workspace')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return join(d, 'follow.json')
}

function load(): void {
  try {
    const o = JSON.parse(readFileSync(file(), 'utf8')) as { v?: number; tasks?: Record<string, Entry> }
    entries = o.v === 1 && o.tasks ? o.tasks : {}
  } catch {
    entries = {}
  }
}

function save(): void {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, tasks: entries }))
  renameSync(tmp, file())
}

// ---------------------------------------------------------------- following

/** The session's assign_task answered: follow the task it created. */
export function onToolResult(e: {
  sessionId: string
  name: string
  input?: unknown
  content: string
  isError?: boolean
}): void {
  if (e.isError || !STARTS.test(e.name)) return
  const taskId = taskIdFromToolResult(e.content)
  if (!taskId) return
  const input = (e.input ?? {}) as { slug?: unknown }
  follow(taskId, e.sessionId, typeof input.slug === 'string' ? input.slug : '')
}

function follow(taskId: number, sessionId: string, employee: string, wake = true): void {
  if (entries[taskId]) return
  entries[taskId] = { sessionId, employee, wake, woken: [] }
  save()
  void refreshTask(taskId)
}

export function followedTasks(sessionId: string): FollowedTask[] {
  return Object.entries(entries)
    .filter(([, e]) => e.sessionId === sessionId)
    .map(([id, e]) => snapshots.get(Number(id)) ?? placeholder(Number(id), e))
    .sort((a, b) => a.id - b.id)
}

export function setFollow(taskId: number, change: FollowChange): void {
  const e = entries[taskId]
  if (!e) return
  if ('unfollow' in change) {
    delete entries[taskId]
    snapshots.delete(taskId)
  } else {
    e.wake = change.wake
    const s = snapshots.get(taskId)
    if (s) snapshots.set(taskId, { ...s, wake: change.wake })
  }
  save()
  emitSession(e.sessionId)
}

/** A task.updated event: refresh it if a session follows it (a few events in a row become one read). */
export function onTaskUpdated(taskId: number): void {
  if (!entries[taskId]) return
  const t = timers.get(taskId)
  if (t) clearTimeout(t)
  timers.set(
    taskId,
    setTimeout(() => {
      timers.delete(taskId)
      void refreshTask(taskId)
    }, DEBOUNCE_MS)
  )
}

function placeholder(id: number, e: Entry): FollowedTask {
  return {
    id,
    sessionId: e.sessionId,
    title: `Tarefa #${id}`,
    employeeName: nameOf(e.employee) ?? e.employee,
    status: '',
    steps: [],
    lines: [],
    costUsd: 0,
    tokens: 0,
    requests: [],
    children: [],
    wake: e.wake,
    updatedAt: new Date().toISOString()
  }
}

function emitSession(sessionId: string): void {
  broadcast(WORKSPACE.evTasks, { sessionId, tasks: followedTasks(sessionId) })
}

async function refreshTask(taskId: number): Promise<void> {
  const e = entries[taskId]
  if (!e) return
  if (!db('sessions').get(e.sessionId)) {
    delete entries[taskId] // the session was deleted: nothing left to show it in
    save()
    return
  }
  const before = snapshots.get(taskId)
  let next: FollowedTask
  try {
    const raw = await platformGet<unknown>(`/api/tasks/${taskId}`)
    next =
      parseFollowedTask(raw, {
        sessionId: e.sessionId,
        employeeName: nameOf(e.employee) ?? e.employee,
        wake: e.wake
      }) ?? placeholder(taskId, e)
  } catch (err) {
    const problem =
      err instanceof PlatformError && /403|forbidden|permiss/i.test(`${err.code} ${err.message}`)
        ? 'A plataforma não deixou o app ler a tarefa (precisa da 0.58.2 ou mais nova, e de acesso a ela).'
        : `Sem contato com a plataforma: ${(err as Error).message}`
    snapshots.set(taskId, { ...(before ?? placeholder(taskId, e)), problem, updatedAt: new Date().toISOString() })
    emitSession(e.sessionId)
    return
  }
  snapshots.set(taskId, next)
  // a colleague took part of the work: the session follows that task too
  for (const c of next.children) if (!entries[c.id]) follow(c.id, e.sessionId, '', e.wake)
  emitSession(e.sessionId)
  wakeIfNeeded(taskId, next)
}

// ---------------------------------------------------------------- waking the session up

function wakeIfNeeded(taskId: number, t: FollowedTask): void {
  const e = entries[taskId]
  if (!e) return
  const marks: { key: string; text: string }[] = []
  if ((TASK_DONE as readonly string[]).includes(t.status) || t.status === 'in_review') {
    marks.push({ key: t.status, text: endMessage(t) })
  }
  if ((TASK_WAITING as readonly string[]).includes(t.status)) {
    for (const r of t.requests) marks.push({ key: `req:${r.id}`, text: requestMessage(t, r) })
  }
  const fresh = marks.filter((m) => !e.woken.includes(m.key))
  if (!fresh.length) return
  e.woken.push(...fresh.map((m) => m.key))
  save()
  const text = fresh.map((m) => m.text).join('\n\n---\n\n')
  if (!e.wake) {
    noteSession(e.sessionId, `Agent Hangar · tarefa #${taskId}: ${t.status}`)
    return
  }
  deliver(e.sessionId, text)
}

function deliver(sessionId: string, text: string): void {
  if (!db('sessions').get(sessionId)) return
  if (sessionState(sessionId).busy) {
    setTimeout(() => deliver(sessionId, text), WAKE_RETRY_MS)
    return
  }
  void sendPrompt(sessionId, text).catch((err) => console.warn('[workspace] follow wake-up failed', err))
}

const STATUS_PT: Record<string, string> = {
  done: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
  expired: 'expirou',
  in_review: 'em revisão'
}

function endMessage(t: FollowedTask): string {
  const who = t.employeeName || 'o funcionário'
  const body = t.result
    ? `Resultado entregue por ${who}:\n\n${t.result.slice(0, RESULT_MAX)}${t.result.length > RESULT_MAX ? '\n…' : ''}`
    : t.error
      ? `Motivo: ${t.error}`
      : 'Sem texto de resultado.'
  const kids = t.children.length
    ? `\n\nTarefas repassadas: ${t.children.map((c) => `#${c.id} ${c.title} (${c.employeeName || 'colega'}, ${c.status})`).join('; ')}.`
    : ''
  return (
    `[Agent Hangar] A tarefa #${t.id} "${t.title}" ${STATUS_PT[t.status] ?? t.status} ` +
    `(custo US$ ${t.costUsd.toFixed(2)}).\n\n${body}${kids}\n\n` +
    'Confira o resultado contra o que foi pedido nesta conversa, resuma para mim o que foi entregue, aponte o que ' +
    'ficou de fora e sugira o próximo passo.'
  )
}

function requestMessage(t: FollowedTask, r: { id: number; kind: string; text: string }): string {
  return (
    `[Agent Hangar] A tarefa #${t.id} "${t.title}" parou esperando uma pessoa: pedido #${r.id} (${r.kind}).\n\n` +
    `${r.text}\n\nExplique o pedido e as opções para mim. A decisão é minha: ela fica em Decisões, no app.`
  )
}

// ---------------------------------------------------------------- lifecycle

export function startFollowing(resolveName: (slug: string) => string | undefined): void {
  nameOf = resolveName
  load()
  for (const id of Object.keys(entries)) void refreshTask(Number(id))
  poll = setInterval(() => {
    for (const [id] of Object.entries(entries)) {
      const s = snapshots.get(Number(id))
      if (!s || !(TASK_DONE as readonly string[]).includes(s.status)) void refreshTask(Number(id))
    }
  }, REFRESH_MS)
}

export function stopFollowing(): void {
  if (poll) clearInterval(poll)
  poll = undefined
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}
