// IPC channels and payload types for the "workspace" feature: the member's screens of the Agent Hangar platform in
// the app (Início, Meus agentes), live badges from the platform's events and `hangar://` deep links.
// Owned by the workspace agent. Contract with the platform: docs/platform/m1-contract.md.

export const WORKSPACE = {
  /** () → WorkspaceState */
  state: 'workspace:state',
  /** (scope?: WorkspaceScope) → WorkspaceState — fetches now (cached data stays on screen while it runs). */
  refresh: 'workspace:refresh',
  /**
   * (target: PortalTarget, label?: string) → boolean — opens that screen of the platform's portal in the system
   * browser; agents, employees and tasks opened with a label go to "Vistos recentemente".
   */
  openPortal: 'workspace:openPortal',
  /** () → WorkspaceNavigation | undefined — a deep link that arrived before the window could take it. */
  takeNavigation: 'workspace:takeNavigation',

  /** main → renderer: WorkspaceState after every change. */
  evState: 'workspace:event:state',
  /** main → renderer: a deep link asks for a screen of the app. */
  evNavigate: 'workspace:event:navigate'
} as const

/** What a refresh fetches: `home` (Início), `agents` (Meus agentes), `badges` or everything. */
export type WorkspaceScope = 'all' | 'home' | 'agents' | 'badges'

/** Native screens of the workspace. */
export type WorkspaceView = 'home' | 'agents'

/** How badges stay current: the event stream (`live`), polling every 60 s while it is down, or nothing (`off`). */
export type WorkspaceLive = 'off' | 'connecting' | 'live' | 'polling'

/** One fetched resource: the last good data (cached on disk) and how the latest fetch went. */
export interface Loadable<T> {
  status: 'idle' | 'loading' | 'ok' | 'error'
  data?: T
  /** Readable error (pt-BR) of the latest failed fetch; `data` (if any) is from before it. */
  error?: string
  fetchedAt?: number
}

export interface WorkingOn {
  id: number
  title: string
}

/** A Digital employee of the person (GET /api/me/workspace → agents, merged with /api/org-chart?mine=1). */
export interface WorkspaceEmployee {
  slug: string
  name: string
  title: string
  /** onboarding | probation | active | paused | offboarded */
  status: string
  personal: boolean
  autonomyLevel?: string
  team?: string
  openDecisions: number
  overdueTasks: number
  cost30dUsd: number
  workingOn?: WorkingOn
  createdAt?: string
  hiredAt?: string
  /** Last time it worked (when the platform says it). */
  lastUsedAt?: string
  /** From the org chart (when fetched). */
  model?: string
  harness?: string
  specialists?: string[]
}

/** A plain agent (not a Digital employee) the person owns, maintains or created (`built_agents`). */
export interface WorkspaceBuiltAgent {
  slug: string
  name: string
  objective: string
  /** draft | tested | test_failed | stage | production */
  status: string
  version?: number
  kind?: string
  team?: string
  /** personal | maintainer | creator */
  why: string
  personal: boolean
  schedules: number
  nextRunAt?: string
  cost30dUsd: number
  lastUsedAt?: string
}

export interface WorkspaceTask {
  id: number
  title: string
  status: string
  createdAt?: string
}

/** GET /api/me/workspace: the member's Início. */
export interface WorkspaceHome {
  workspace: string
  llmReady: boolean
  toDecide: number
  agents: WorkspaceEmployee[]
  builtAgents: WorkspaceBuiltAgent[]
  myTasks: WorkspaceTask[]
  monthCostUsd: number
  personalSpentUsd: number
  personalCapUsd: number
  personalAllowed: boolean
  personalCount: number
  personalMax: number
}

/** One open decision (GET /api/decisions). */
export interface WorkspaceDecision {
  id: number
  /** approval | question | notice | plan | … */
  kind: string
  employee?: string
  employeeName: string
  employeeTitle: string
  question?: string
  taskTitle?: string
  /** Assigned to this person (the rest are ones they may take as fallback/approver). */
  mine: boolean
  createdAt?: string
  expiresAt?: string
}

/** GET /api/org-chart?mine=1, the part Meus agentes uses. */
export interface WorkspaceChartNode {
  slug: string
  name: string
  title: string
  status: string
  level?: string
  team?: string
  model?: string
  harness?: string
  specialists: string[]
  personal: boolean
  workingOn?: WorkingOn
}

export interface WorkspaceChart {
  nodes: WorkspaceChartNode[]
}

/** GET /api/inbox → counts. */
export interface InboxCounts {
  all: number
  unread: number
  decisions: number
  blocked: number
}

/** Something the person saw in the app's workspace (the "Vistos recentemente" card). */
export interface RecentItem {
  target: PortalTarget
  label: string
  at: number
}

export interface WorkspaceState {
  /** The platform is not off (the section shows). */
  enabled: boolean
  /** Logged in to the platform (otherwise the section shows "Conecte à plataforma"). */
  connected: boolean
  /** The person's first name, for the greeting. */
  firstName?: string
  live: WorkspaceLive
  badges: { decisions?: number; inbox?: number }
  home: Loadable<WorkspaceHome>
  decisions: Loadable<WorkspaceDecision[]>
  chart: Loadable<WorkspaceChart>
  inbox: Loadable<InboxCounts>
  recent: RecentItem[]
}

/**
 * A screen of the platform's portal (`<url>/app#/…`) the app may open in the browser: a closed list, so nothing
 * else (and no arbitrary URL) can be opened through it.
 */
export type PortalTarget =
  | { screen: 'home' | 'mine' | 'decisions' | 'inbox' | 'org' | 'connect-ai' | 'my-issues' }
  | { screen: 'decision'; id: number }
  | { screen: 'task'; id: number }
  | { screen: 'agent'; slug: string }
  | { screen: 'employee'; slug: string }

/** Where a deep link (or a click) leads: a native screen of the app, or the portal. */
export type WorkspaceNavigation = { view: WorkspaceView } | { portal: PortalTarget }

/** Slugs of agents on the platform: lowercase letters, digits, `-` and `_`. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/
const ID_RE = /^[1-9]\d{0,11}$/

export function validPortalTarget(t: unknown): t is PortalTarget {
  if (!t || typeof t !== 'object') return false
  const x = t as { screen?: unknown; id?: unknown; slug?: unknown }
  switch (x.screen) {
    case 'home':
    case 'mine':
    case 'decisions':
    case 'inbox':
    case 'org':
    case 'connect-ai':
    case 'my-issues':
      return Object.keys(x).length === 1
    case 'decision':
    case 'task':
      return typeof x.id === 'number' && ID_RE.test(String(x.id))
    case 'agent':
    case 'employee':
      return typeof x.slug === 'string' && SLUG_RE.test(x.slug)
    default:
      return false
  }
}

/** The portal's hash route of a target (`#/…`). Decisions have no page of their own on the portal yet. */
export function portalHash(t: PortalTarget): string {
  switch (t.screen) {
    case 'home':
      return '#/'
    case 'decision':
      return '#/decisions'
    case 'task':
      return `#/tasks/${t.id}`
    case 'agent':
      return `#/agents/${t.slug}`
    case 'employee':
      return `#/employees/${t.slug}`
    default:
      return `#/${t.screen}`
  }
}

/** Longest deep link accepted. */
export const DEEP_LINK_MAX = 200

/**
 * `hangar://open/<route>` → where it leads, or undefined for anything outside the closed list:
 *
 *   workspace | workspace/home        Início (native)
 *   workspace/agents | mine           Meus agentes (native)
 *   decisions[/<id>] | inbox          portal (until M2)
 *   tasks/<id> | agents/<slug> | employees/<slug> | org | connect-ai | my-issues   portal
 *
 * No query, fragment, credentials, port, percent-encoding or extra segments; one trailing `/` is tolerated.
 */
export function parseDeepLink(raw: unknown): WorkspaceNavigation | undefined {
  if (typeof raw !== 'string' || raw.length > DEEP_LINK_MAX) return undefined
  const m = /^hangar:\/\/open\/([A-Za-z0-9/_-]*)$/i.exec(raw.trim())
  if (!m) return undefined
  const parts = m[1].replace(/\/$/, '').split('/')
  if (parts.some((p) => !p)) return undefined
  const [head, arg, ...rest] = parts
  if (rest.length) return undefined
  const one = (nav: WorkspaceNavigation) => (arg === undefined ? nav : undefined)
  switch (head) {
    case 'workspace':
      if (arg === undefined || arg === 'home') return { view: 'home' }
      if (arg === 'agents') return { view: 'agents' }
      return undefined
    case 'mine':
      return one({ view: 'agents' })
    case 'decisions':
      if (arg === undefined) return { portal: { screen: 'decisions' } }
      return ID_RE.test(arg) ? { portal: { screen: 'decision', id: Number(arg) } } : undefined
    case 'tasks':
      return arg !== undefined && ID_RE.test(arg) ? { portal: { screen: 'task', id: Number(arg) } } : undefined
    case 'agents':
      return arg !== undefined && SLUG_RE.test(arg) ? { portal: { screen: 'agent', slug: arg } } : undefined
    case 'employees':
      return arg !== undefined && SLUG_RE.test(arg) ? { portal: { screen: 'employee', slug: arg } } : undefined
    case 'inbox':
    case 'org':
    case 'connect-ai':
    case 'my-issues':
      return one({ portal: { screen: head } })
    default:
      return undefined
  }
}

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [WORKSPACE.state]: () => WorkspaceState
    [WORKSPACE.refresh]: (scope?: WorkspaceScope) => WorkspaceState
    [WORKSPACE.openPortal]: (target: PortalTarget, label?: string) => boolean
    [WORKSPACE.takeNavigation]: () => WorkspaceNavigation | undefined
  }

  interface IpcEventContract {
    [WORKSPACE.evState]: WorkspaceState
    [WORKSPACE.evNavigate]: WorkspaceNavigation
  }
}
