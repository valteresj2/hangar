// Validation of the platform's member routes and events (docs/platform/m1-contract.md): untrusted JSON in, the
// app's types out. Pure; garbage becomes empty values instead of exceptions, so one odd field never blanks a screen.
import type {
  InboxCounts,
  WorkingOn,
  WorkspaceBuiltAgent,
  WorkspaceChart,
  WorkspaceChartNode,
  WorkspaceDecision,
  WorkspaceEmployee,
  WorkspaceHome,
  WorkspaceTask
} from '../../../shared/features/workspace'
import { SLUG_RE } from '../../../shared/features/workspace'

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
    expiresAt: when(o.expires_at)
  }
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

// ---------------------------------------------------------------- events (GET /api/app/events)

export type WorkspaceEvent =
  | { type: 'inbox.changed'; unread: number }
  /** `agent`: the agent's slug. */
  | { type: 'decision.created'; id: number; title: string; agent?: string }
  | { type: 'decision.decided'; id: number }
  | { type: 'agent.status'; slug: string; status: string }
  | { type: 'models.changed'; version?: string }

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
    default:
      return undefined
  }
}
