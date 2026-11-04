// Validation of the platform's member routes and events (docs/platform/m1-contract.md): untrusted JSON in, the
// app's types out. Pure; garbage becomes empty values instead of exceptions, so one odd field never blanks a screen.
import type {
  AgentDetail,
  InboxCounts,
  InboxItem,
  WorkingOn,
  WorkspaceBuiltAgent,
  WorkspaceChart,
  WorkspaceChartNode,
  WorkspaceDecision,
  WorkspaceEmployee,
  WorkspaceHome,
  WorkspaceTask
} from '../../../shared/features/workspace'
import {
  SLUG_RE,
  type FollowedTask,
  type TaskFile,
  type TaskJob,
  type TaskLine,
  type TaskLink,
  type TaskRequest
} from '../../../shared/features/workspace'

type Obj = Record<string, unknown>

const MAX_LIST = 500
const MAX_TEXT = 2000

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_LIST) : [])
const str = (v: unknown, max = MAX_TEXT): string =>
  typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
const optStr = (v: unknown, max = MAX_TEXT): string | undefined => str(v, max) || undefined
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const count = (v: unknown): number => Math.max(0, Math.floor(num(v)))
const id = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0
    ? v
    : typeof v === 'string' && /^\d{1,12}$/.test(v) && Number(v) > 0
      ? Number(v)
      : undefined
const slug = (v: unknown): string | undefined => (typeof v === 'string' && SLUG_RE.test(v) ? v : undefined)
/** ISO-like timestamps only (the UI formats them); without an offset the platform means UTC. */
function when(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined
  const iso = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? `${v}Z` : v
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

function workingOn(v: unknown): WorkingOn | undefined {
  const o = obj(v)
  const i = id(o?.id)
  return o && i ? { id: i, title: str(o.title, 300) } : undefined
}

function lastUsed(o: Obj): string | undefined {
  return when(o.last_used_at) ?? when(o.last_run_at) ?? when(o.last_task_at)
}

export function parseEmployee(v: unknown): WorkspaceEmployee | undefined {
  const o = obj(v)
  const s = slug(o?.slug)
  if (!o || !s) return undefined
  return {
    slug: s,
    name: str(o.name, 200) || s,
    title: str(o.title, 300),
    status: str(o.status, 40),
    personal: o.personal === true,
    autonomyLevel: optStr(o.autonomy_level, 40),
    // The workspace gives the team's id here; the org chart has its slug.
    team: typeof o.team === 'string' ? optStr(o.team, 200) : undefined,
    openDecisions: count(o.open_decisions),
    overdueTasks: count(o.overdue_tasks),
    cost30dUsd: num(o.cost_30d),
    workingOn: workingOn(o.working_on),
    createdAt: when(o.created_at),
    hiredAt: when(o.hired_at),
    lastUsedAt: lastUsed(o)
  }
}

export function parseBuiltAgent(v: unknown): WorkspaceBuiltAgent | undefined {
  const o = obj(v)
  const s = slug(o?.slug)
  if (!o || !s) return undefined
  const version = count(o.version)
  return {
    slug: s,
    name: str(o.name, 200) || s,
    objective: str(o.objective, 400),
    status: str(o.status, 40),
    version: version || undefined,
    kind: optStr(o.kind, 40),
    team: optStr(o.team, 200),
    why: str(o.why, 40),
    personal: o.personal === true,
    schedules: count(o.schedules),
    nextRunAt: when(o.next_run_at),
    cost30dUsd: num(o.cost_30d_usd),
    lastUsedAt: lastUsed(o)
  }
}

function parseTask(v: unknown): WorkspaceTask | undefined {
  const o = obj(v)
  const i = id(o?.id)
  if (!o || !i) return undefined
  return { id: i, title: str(o.title, 300), status: str(o.status, 40), createdAt: when(o.created_at) }
}

const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined)

/** GET /api/me/workspace (an empty object for a principal without a user). */
export function parseHome(v: unknown): WorkspaceHome {
  const o = obj(v) ?? {}
  return {
    workspace: str(o.workspace, 200),
    llmReady: o.llm_ready !== false,
    toDecide: count(o.to_decide),
    agents: defined(list(o.agents).map(parseEmployee)),
    builtAgents: defined(list(o.built_agents).map(parseBuiltAgent)),
    myTasks: defined(list(o.my_tasks).map(parseTask)),
    monthCostUsd: num(o.month_cost_usd),
    personalSpentUsd: num(o.personal_spent_usd),
    personalCapUsd: num(o.personal_cap_usd),
    personalAllowed: o.personal_allowed === true,
    personalCount: count(o.personal_count),
    personalMax: count(o.personal_max)
  }
}

export function parseDecision(v: unknown): WorkspaceDecision | undefined {
  const o = obj(v)
  const i = id(o?.id)
  if (!o || !i) return undefined
  const task = obj(o.task)
  return {
    id: i,
    kind: str(o.kind, 40),
    employee: slug(o.employee),
    employeeName: str(o.employee_name, 200),
    employeeTitle: str(o.employee_title, 300),
    // What to show: the question, else the task's title, else the tool.
    question: optStr(o.question, 500),
    taskTitle: optStr(task?.title, 300) ?? optStr(o.tool, 200),
    mine: o.mine === true,
    createdAt: when(o.created_at),
    expiresAt: when(o.expires_at),
    rationale: optStr(o.rationale, 2000),
    risk: optStr(o.risk, 20),
    tool: optStr(o.tool, 200),
    payload: payloadText(o.payload),
    taskId: id(task?.id),
    approvals: list(o.approvals).length,
    approvalsNeeded: o.mode === 'approve_2' ? 2 : 1
  }
}

/** The action's arguments as indented JSON, cut when long (the card shows it as is). */
function payloadText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  let text: string
  try {
    text = JSON.stringify(v, null, 2)
  } catch {
    return undefined
  }
  if (!text || text === '{}') return undefined
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text
}

/** GET /api/decisions: a list (an object with `items` is accepted too). */
export function parseDecisions(v: unknown): WorkspaceDecision[] {
  const items = Array.isArray(v) ? v : obj(v)?.items
  return defined(list(items).map(parseDecision))
}

/** Decisions that ask something of the person (notices only inform): the badge and the Início card. */
export const toDecide = (ds: WorkspaceDecision[]): WorkspaceDecision[] => ds.filter((d) => d.kind !== 'notice')

function parseNode(v: unknown): WorkspaceChartNode | undefined {
  const o = obj(v)
  const s = slug(o?.slug)
  if (!o || !s) return undefined
  return {
    slug: s,
    name: str(o.name, 200) || s,
    title: str(o.title, 300),
    status: str(o.status, 40),
    level: optStr(o.level, 40),
    team: optStr(o.team, 200),
    model: optStr(o.model, 200),
    harness: optStr(o.harness, 80),
    specialists: defined(list(o.specialists).map((x) => optStr(obj(x)?.name, 200))),
    personal: o.personal === true,
    workingOn: workingOn(o.working_on)
  }
}

/** GET /api/org-chart?mine=1 (only the nodes: Meus agentes merges them into the workspace's agents). */
export function parseChart(v: unknown): WorkspaceChart {
  return { nodes: defined(list(obj(v)?.nodes).map(parseNode)) }
}

/** GET /api/inbox → counts. */
export function parseInbox(v: unknown): InboxCounts {
  const c = obj(obj(v)?.counts) ?? {}
  return { all: count(c.all), unread: count(c.unread), decisions: count(c.decisions), blocked: count(c.blocked) }
}

/** GET /api/inbox?view=… → its items (the counts come from parseInbox). */
export function parseInboxItems(v: unknown): InboxItem[] {
  const out: InboxItem[] = []
  for (const x of list(obj(v)?.items)) {
    const o = obj(x)
    const key = str(o?.key, 80)
    if (!o || !/^[a-z_]+:[^\s]{1,70}$/.test(key)) continue
    const decision = key.startsWith('decision:') ? id(key.slice('decision:'.length)) : undefined
    out.push({
      key,
      kind: str(o.kind, 40),
      title: str(o.title, 500) || key,
      at: when(o.at),
      unread: o.unread === true,
      archived: o.archived === true,
      blocked: o.blocked === true,
      requested: o.requested === true || o.mine === true,
      employee: slug(o.employee),
      employeeName: optStr(o.employee_name, 200),
      status: optStr(o.status, 40),
      decisionId: decision,
      taskId: id(o.task_id)
    })
  }
  return out
}

/** GET /api/agents/{slug}: what Meus agentes shows when an agent is opened. */
export function parseAgentDetail(v: unknown): AgentDetail | undefined {
  const o = obj(v)
  const s = slug(o?.slug)
  if (!o || !s) return undefined
  const test = obj(o.last_test)
  const cost = o.cost_7d
  return {
    slug: s,
    name: str(o.name, 200) || s,
    kind: str(o.kind, 40),
    status: str(o.status, 40),
    version: id(o.version),
    model: optStr(o.model, 200),
    stageVersion: id(obj(o.stage)?.version),
    prodVersion: id(obj(o.prod)?.version),
    requests7d: typeof o.requests_7d === 'number' ? count(o.requests_7d) : undefined,
    cost7d: typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined,
    permissions: list(o.permissions).filter((p): p is string => typeof p === 'string' && p.length < 40),
    versions: defined(
      list(o.versions).map((x) => {
        const vo = obj(x)
        const n = id(vo?.version)
        return vo && n
          ? { version: n, createdBy: optStr(vo.created_by, 200), createdAt: when(vo.created_at) }
          : undefined
      })
    ).sort((a, b) => b.version - a.version),
    lastTest: test
      ? {
          version: id(test.version),
          status: str(test.status, 40),
          summary: optStr(test.summary, 300),
          at: when(test.created_at)
        }
      : undefined
  }
}

// ---------------------------------------------------------------- events (GET /api/app/events)

export type WorkspaceEvent =
  | { type: 'inbox.changed'; unread: number }
  /** `agent`: the agent's slug. */
  | { type: 'decision.created'; id: number; title: string; agent?: string }
  | { type: 'decision.decided'; id: number }
  | { type: 'agent.status'; slug: string; status: string }
  | { type: 'models.changed'; version?: string }
  | { type: 'task.updated'; id: number; status: string }

/** One SSE event of the platform → a known event, or undefined (unknown types and bad payloads are ignored). */
export function parseEvent(type: string, data: string): WorkspaceEvent | undefined {
  let o: Obj | undefined
  try {
    o = obj(JSON.parse(data || '{}'))
  } catch {
    return undefined
  }
  if (!o) return undefined
  switch (type) {
    case 'inbox.changed':
      return typeof o.unread === 'number' ? { type, unread: count(o.unread) } : undefined
    case 'decision.created': {
      const i = id(o.id)
      return i ? { type, id: i, title: str(o.title, 300), agent: optStr(o.agent, 200) } : undefined
    }
    case 'decision.decided': {
      const i = id(o.id)
      return i ? { type, id: i } : undefined
    }
    case 'agent.status': {
      const s = slug(o.slug)
      const status = str(o.status, 40)
      return s && status ? { type, slug: s, status } : undefined
    }
    case 'models.changed':
      return { type, version: optStr(o.version, 200) }
    case 'task.updated': {
      const i = id(o.id)
      return i ? { type, id: i, status: str(o.status, 40) } : undefined
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- following a task

/** The task id an assign_task (or handoff) call answered with: the platform MCP returns the task as JSON text. */
export function taskIdFromToolResult(content: string): number | undefined {
  try {
    const o = obj(JSON.parse(content))
    return id(o?.id) ?? id(obj(o?.task)?.id)
  } catch {
    const m = /(?:tarefa|task)\s*(?:n[ºo°.]*\s*)?#?\s*(\d{1,9})\b/i.exec(content)
    return m ? id(Number(m[1])) : undefined
  }
}

const short = (v: unknown, max = 160): string => str(v, max).replace(/\s+/g, ' ')

/** One timeline event of the platform → a line in words (checkpoints and internal bookkeeping are left out). */
export function taskLine(v: unknown): TaskLine | undefined {
  const o = obj(v)
  const p = obj(o?.payload) ?? {}
  const kind = str(o?.kind, 30)
  const at = when(o?.at) ?? ''
  const text = (() => {
    switch (kind) {
      case 'created':
        return 'Tarefa criada'
      case 'run':
        return `Rodada ${count(p.run)}${p.env ? ` (${short(p.env, 20)})` : ''}`
      case 'tool': {
        // a step of the workstation (summary, whether it worked, how long) or of a platform round
        const secs = count(p.ms) >= 1000 ? ` · ${Math.round(count(p.ms) / 1000)} s` : ''
        const what = p.summary ? `${short(p.tool, 40)}: ${short(p.summary, 160)}` : `Ferramenta ${short(p.tool, 80)}`
        return `${what}${p.ok === false || p.error ? ' (falhou)' : ''}${secs}`
      }
      case 'file':
        return `Arquivo ${short(p.name, 120)}${count(p.version) > 1 ? ` v${count(p.version)}` : ''}`
      case 'gate':
        return `Alçada: ${short(p.tool, 60)} → ${short(p.mode, 20) || short(p.status, 20)}`
      case 'note':
        return short(p.worker ?? p.continue ?? p.waiting ?? p.retry_at ?? '', 240) || 'Nota'
      case 'human_request':
        return `Pedido #${count(p.id)} (${short(p.kind, 20)})${p.question || p.need ? `: ${short(p.question ?? p.need, 200)}` : ''}`
      case 'decision':
        return `Decisão #${count(p.id)}: ${short(p.decision, 30)}`
      case 'handoff':
        return p.to ? `Repasse → ${short(p.to, 60)} (tarefa #${count(p.task)})` : 'Repasse'
      case 'handoff_done':
        return `Tarefa repassada #${count(p.task)} terminou: ${short(p.status, 20)}`
      case 'plan':
        return `Plano: ${count(p.done)} de ${count(p.total)} etapas`
      case 'nudge':
        return 'Lembrete: anunciou o próximo passo sem executar'
      case 'done':
        return 'Entregue'
      case 'error':
        return `Erro: ${short(p.error, 200)}`
      default:
        return ''
    }
  })()
  return text ? { at, kind, text } : undefined
}

function taskLink(v: unknown): TaskLink | undefined {
  const o = obj(v)
  const i = id(o?.id)
  return o && i
    ? {
        id: i,
        title: str(o.title, 200),
        status: str(o.status, 40),
        employee: slug(o.employee) ?? '',
        employeeName: str(o.employee_name, 120)
      }
    : undefined
}

function taskRequest(v: unknown): TaskRequest | undefined {
  const o = obj(v)
  const i = id(o?.id)
  if (!o || !i || o.status !== 'open') return undefined
  const p = obj(o.payload)
  return { id: i, kind: str(o.kind, 30), text: short(o.question ?? p?.need ?? o.tool ?? o.kind, 400) }
}

function taskFile(v: unknown): TaskFile | undefined {
  const o = obj(v)
  const i = id(o?.id)
  const name = str(o?.name, 200)
  return o && i && name
    ? { id: i, name, version: count(o.version) || 1, kind: str(o.kind, 20), size: count(o.size) }
    : undefined
}

/** The task's long jobs (one `job` event each, updated in place), the running ones first, the last few. */
export function taskJobs(events: unknown[], max = 4): TaskJob[] {
  const jobs = new Map<string, TaskJob>()
  for (const ev of events) {
    const o = obj(ev)
    const p = obj(o?.payload)
    const jid = str(p?.id, 60)
    if (o?.kind !== 'job' || !p || !jid) continue
    const total = num(p.total)
    jobs.set(jid, {
      id: jid,
      label: str(p.label, 120),
      done: num(p.done),
      total: total > 0 ? total : undefined,
      unit: str(p.unit, 20),
      etaS: typeof p.eta_s === 'number' ? count(p.eta_s) : undefined,
      state: str(p.state, 20) || 'running',
      started: when(p.started) ?? '',
      at: when(p.at) ?? when(o.at) ?? ''
    })
  }
  const list = [...jobs.values()].slice(-max)
  return [...list.filter((j) => j.state === 'running'), ...list.filter((j) => j.state !== 'running')]
}

/** The web links in a result, in order and once each (trailing punctuation and markdown brackets left out). */
export function resultLinks(text: string | undefined, max = 10): string[] {
  const out: string[] = []
  for (const m of (text ?? '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?*_]+$/, '')
    if (!out.includes(url)) out.push(url)
    if (out.length >= max) break
  }
  return out
}

/** GET /api/tasks/{id} → what the session's task card shows (the last lines of the timeline, newest last). */
export function parseFollowedTask(
  v: unknown,
  base: { sessionId: string; employeeName: string; wake: boolean }
): FollowedTask | undefined {
  const o = obj(v)
  const i = id(o?.id)
  if (!o || !i) return undefined
  const prog = obj(o.progress)
  const result = optStr(o.result, 20000)
  const files = defined(list(o.files).map(taskFile))
  return {
    id: i,
    sessionId: base.sessionId,
    title: str(o.title, 300),
    employeeName: base.employeeName,
    status: str(o.status, 40),
    steps: list(o.plan)
      .map((x) => obj(x))
      .filter((x): x is Obj => !!x && !!str(x.title))
      .map((x) => ({ title: str(x.title, 200), status: str(x.status, 20) || 'todo' })),
    progress: prog ? { done: count(prog.done), total: count(prog.total), pct: count(prog.pct) } : undefined,
    lines: defined(list(o.events).map(taskLine)).slice(-8),
    costUsd: num(o.cost_usd),
    tokens: count(o.tokens),
    result,
    error: optStr(o.error, 2000),
    requests: defined(list(o.requests).map(taskRequest)),
    children: defined(list(o.children).map(taskLink)),
    parent: taskLink(o.parent),
    files: [...files.filter((f) => f.kind !== 'input'), ...files.filter((f) => f.kind === 'input')],
    links: resultLinks(result),
    jobs: taskJobs(list(o.events)),
    wake: base.wake,
    updatedAt: new Date().toISOString()
  }
}
