// The member's workspace in the app (docs/platform/m1-contract.md): reads the member routes through the platform
// feature's login, keeps the last answers in memory and on disk (to open fast and show something offline), follows
// the platform's event stream for live badges (polling every 60 s while it is down) and routes deep links.
//
// Files in <userData>/hangar-data/workspace/:
//   cache.json   { v, key: "<url> <userId>", home, decisions, chart, inbox, savedAt } — no secrets; dropped on logout
//   recent.json  [{ target, label, at }] — what the person opened from the app ("Vistos recentemente")
import { app, powerMonitor, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  portalHash,
  validPortalTarget,
  WORKSPACE,
  type AgentAction,
  type AgentActionResult,
  type AgentDetail,
  type DecideInput,
  type DecideResult,
  type InboxCounts,
  type InboxItem,
  type InboxMark,
  type InboxView,
  type Loadable,
  type PortalTarget,
  type RecentItem,
  type WorkspaceChart,
  type WorkspaceDecision,
  type WorkspaceHome,
  type WorkspaceLive,
  type WorkspaceNavigation,
  type WorkspaceScope,
  type WorkspaceState
} from '../../../shared/features/workspace'
import { broadcast } from '../../core/broadcast'
import type { FeatureContext } from '../../core/feature'
import { openExternalLink } from '../../core/window'
import {
  onPlatformState,
  platformGet,
  platformLogin,
  platformSend,
  platformState,
  platformStream,
  platformUrl,
  PlatformError,
  recheckPlatform,
  syncPlatformModels,
  type PlatformState
} from '../platform/api'
import {
  parseAgentDetail,
  parseChart,
  parseDecisions,
  parseEvent,
  parseHome,
  parseInbox,
  parseInboxItems,
  toDecide,
  type WorkspaceEvent
} from './parse'
import { onTaskUpdated } from './follow'
import { EventStream, type SseMessage } from './sse'

interface Resources {
  home: Loadable<WorkspaceHome>
  decisions: Loadable<WorkspaceDecision[]>
  chart: Loadable<WorkspaceChart>
  inbox: Loadable<InboxCounts>
}
type Key = keyof Resources

interface StoredCache {
  v: number
  key: string
  home?: { data: WorkspaceHome; fetchedAt: number }
  decisions?: { data: WorkspaceDecision[]; fetchedAt: number }
  chart?: { data: WorkspaceChart; fetchedAt: number }
  inbox?: { data: InboxCounts; fetchedAt: number }
}

const ROUTES: { [K in Key]: { path: string; parse: (v: unknown) => NonNullable<Resources[K]['data']> } } = {
  home: { path: '/api/me/workspace', parse: parseHome },
  decisions: { path: '/api/decisions', parse: parseDecisions },
  chart: { path: '/api/org-chart?mine=1', parse: parseChart },
  inbox: { path: '/api/inbox?view=unread', parse: parseInbox }
}
const EVENTS_PATH = '/api/app/events'
const CACHE_VERSION = 1
/** Events come in bursts (a decision also changes the inbox): one refresh after them. */
const EVENT_REFRESH_MS = 1_500
const RECHECK_EVERY_MS = 30_000
const RECENT_MAX = 8
/** A deep link waits this long for the window to take it. */
const NAVIGATION_TTL_MS = 120_000

const idle = <T>(): Loadable<T> => ({ status: 'idle' })
const empty = (): Resources => ({ home: idle(), decisions: idle(), chart: idle(), inbox: idle() })

let ctxRef: FeatureContext | undefined
let res: Resources = empty()
let live: WorkspaceLive = 'off'
/** `<url> <userId>` of the login the data belongs to. */
let loginKey: string | undefined
let enabled = false
let firstName: string | undefined
/** Meus agentes was opened: the org chart is part of every refresh from then on. */
let chartWanted = false
const inflight = new Map<Key, Promise<void>>()
let pendingScopes = new Set<WorkspaceScope>()
let eventTimer: NodeJS.Timeout | undefined
let saveTimer: NodeJS.Timeout | undefined
let lastRecheck = 0
let pendingNavigation: { nav: WorkspaceNavigation; at: number } | undefined
const queuedPortal: PortalTarget[] = []
let windowCreated = false

// ---------------------------------------------------------------- disk

function dir(): string {
  const d = join(app.getPath('userData'), 'hangar-data', 'workspace')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  const target = join(dir(), name)
  writeFileSync(`${target}.tmp`, JSON.stringify(value), 'utf8')
  renameSync(`${target}.tmp`, target)
}

function saveCacheSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    if (!loginKey) return
    const out: StoredCache = { v: CACHE_VERSION, key: loginKey }
    for (const k of Object.keys(ROUTES) as Key[]) {
      const r = res[k]
      if (r.data !== undefined && r.fetchedAt) Object.assign(out, { [k]: { data: r.data, fetchedAt: r.fetchedAt } })
    }
    try {
      writeJson('cache.json', out)
    } catch (err) {
      console.warn('[workspace] cache not saved', err)
    }
  }, 500)
}

function loadCache(key: string): Resources {
  const stored = readJson<StoredCache | null>('cache.json', null)
  const out = empty()
  if (stored?.v !== CACHE_VERSION || stored.key !== key) return out
  for (const k of Object.keys(ROUTES) as Key[]) {
    const entry = stored[k]
    if (entry && shapeOk(k, entry.data))
      Object.assign(out, { [k]: { status: 'idle', data: entry.data, fetchedAt: entry.fetchedAt } })
  }
  return out
}

/** The cache holds parsed data; a file of another shape (edited, older app) is ignored. */
function shapeOk(k: Key, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  switch (k) {
    case 'home': {
      const h = data as WorkspaceHome
      return Array.isArray(h.agents) && Array.isArray(h.builtAgents) && Array.isArray(h.myTasks)
    }
    case 'decisions':
      return Array.isArray(data)
    case 'chart':
      return Array.isArray((data as WorkspaceChart).nodes)
    case 'inbox':
      return typeof (data as InboxCounts).unread === 'number'
  }
}

function dropCache(): void {
  rmSync(join(dir(), 'cache.json'), { force: true })
}

function recent(): RecentItem[] {
  const list = readJson<unknown>('recent.json', [])
  return (Array.isArray(list) ? list : [])
    .filter(
      (x): x is RecentItem =>
        !!x &&
        typeof x === 'object' &&
        validPortalTarget((x as RecentItem).target) &&
        typeof (x as RecentItem).label === 'string' &&
        typeof (x as RecentItem).at === 'number'
    )
    .slice(0, RECENT_MAX)
}

function remember(target: PortalTarget, label: string): void {
  const same = (x: RecentItem) => portalHash(x.target) === portalHash(target)
  const next = [{ target, label: label.slice(0, 200), at: Date.now() }, ...recent().filter((x) => !same(x))]
  try {
    writeJson('recent.json', next.slice(0, RECENT_MAX))
  } catch (err) {
    console.warn('[workspace] recent not saved', err)
  }
}

// ---------------------------------------------------------------- state

export function getState(): WorkspaceState {
  const decisions = res.decisions.data
  return {
    enabled,
    connected: !!loginKey,
    firstName,
    live,
    badges: {
      decisions: decisions ? toDecide(decisions).length : undefined,
      inbox: res.inbox.data?.unread
    },
    ...res,
    recent: loginKey ? recent() : []
  }
}

function emit(): WorkspaceState {
  const s = getState()
  broadcast(WORKSPACE.evState, s)
  return s
}

// ---------------------------------------------------------------- fetching

function keysOf(scope: WorkspaceScope): Key[] {
  switch (scope) {
    case 'home':
      return ['home', 'decisions']
    case 'agents':
      return ['home', 'chart']
    case 'badges':
      return ['decisions', 'inbox']
    case 'all':
      return chartWanted ? ['home', 'decisions', 'inbox', 'chart'] : ['home', 'decisions', 'inbox']
  }
}

/** A refused login: the platform feature checks it again (and logs out the usual way when it really ended). */
function maybeRecheck(err: unknown): void {
  if (!(err instanceof PlatformError)) return
  if (err.code !== 'session_expired' && err.code !== 'forbidden') return
  if (Date.now() - lastRecheck < RECHECK_EVERY_MS) return
  lastRecheck = Date.now()
  void recheckPlatform()
}

function errorText(err: unknown): string {
  if (err instanceof PlatformError && err.code === 'forbidden')
    return 'A plataforma não liberou esta tela para o app. Ela pode estar desatualizada; use o portal no navegador.'
  if (err instanceof PlatformError && err.code === 'not_found')
    return 'A plataforma não tem esta tela para o app (versão antiga). Use o portal no navegador.'
  return err instanceof Error ? err.message : String(err)
}

function load<K extends Key>(k: K): Promise<void> {
  const running = inflight.get(k)
  if (running) return running
  const key = loginKey
  if (!key) return Promise.resolve()
  res = { ...res, [k]: { ...res[k], status: 'loading', error: undefined } }
  const run = (async () => {
    try {
      const raw = await platformGet<unknown>(ROUTES[k].path)
      if (loginKey !== key) return
      res = { ...res, [k]: { status: 'ok', data: ROUTES[k].parse(raw), fetchedAt: Date.now() } }
      saveCacheSoon()
    } catch (err) {
      if (loginKey !== key) return
      res = { ...res, [k]: { ...res[k], status: 'error', error: errorText(err) } }
      maybeRecheck(err)
    }
  })()
  inflight.set(k, run)
  void run.finally(() => {
    if (inflight.get(k) === run) inflight.delete(k)
    emit()
  })
  return run
}

export async function refresh(scope: WorkspaceScope = 'all'): Promise<WorkspaceState> {
  if (scope === 'agents') chartWanted = true
  if (loginKey) {
    const keys = keysOf(scope)
    const running = Promise.all(keys.map((k) => load(k)))
    emit()
    await running
  }
  return getState()
}

function refreshSoon(scope: WorkspaceScope): void {
  pendingScopes.add(scope)
  if (eventTimer) return
  eventTimer = setTimeout(() => {
    eventTimer = undefined
    const scopes = pendingScopes
    pendingScopes = new Set()
    const keys = new Set([...scopes].flatMap(keysOf))
    for (const k of keys) void load(k)
  }, EVENT_REFRESH_MS)
}

// ---------------------------------------------------------------- actions (M2: decide, inbox, agents)

const INBOX_VIEWS: InboxView[] = ['all', 'unread', 'decisions', 'blocked', 'mine', 'archived']
const DECISIONS = new Set(['approve', 'reject', 'instruct', 'answer', 'ack'])

function connected(): void {
  if (!loginKey) throw new PlatformError('not_connected', 'O Hangar não está conectado à plataforma.')
}

function actionError(err: unknown): Error {
  if (err instanceof PlatformError && err.code === 'forbidden')
    return new Error(
      'A plataforma não deixou: você não tem permissão para isso, ou ela é de uma versão anterior à 0.55.'
    )
  return err instanceof Error ? err : new Error(String(err))
}

export async function inboxItems(view: InboxView): Promise<InboxItem[]> {
  connected()
  const v = INBOX_VIEWS.includes(view) ? view : 'all'
  try {
    return parseInboxItems(await platformGet<unknown>(`/api/inbox?view=${v}`))
  } catch (err) {
    throw actionError(err)
  }
}

export async function markInbox(keys: string[], change: InboxMark): Promise<void> {
  connected()
  const clean = keys.filter((k) => typeof k === 'string' && /^[a-z_]+:[^\s]{1,70}$/.test(k)).slice(0, 200)
  if (!clean.length) return
  const body: { keys: string[]; read?: boolean; archived?: boolean } = { keys: clean }
  if (typeof change.read === 'boolean') body.read = change.read
  if (typeof change.archived === 'boolean') body.archived = change.archived
  try {
    await platformSend('POST', '/api/inbox/mark', body)
  } catch (err) {
    throw actionError(err)
  }
  void load('inbox').then(emit)
}

export async function decide(input: DecideInput): Promise<DecideResult> {
  connected()
  const rid = Number(input?.id)
  if (!Number.isInteger(rid) || rid <= 0) throw new Error('Decisão inválida.')
  if (!DECISIONS.has(input.decision)) throw new Error('Escolha uma opção da decisão.')
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 4000) : ''
  let out: { message?: unknown; status?: unknown }
  try {
    out = await platformSend<{ message?: unknown; status?: unknown }>('POST', `/api/decisions/${rid}`, {
      decision: input.decision,
      reason
    })
  } catch (err) {
    throw actionError(err)
  }
  // Gone from the list at once; the refresh brings the rest (badges, Início, the inbox).
  if (res.decisions.data && out?.status !== 'open')
    res.decisions = { ...res.decisions, data: res.decisions.data.filter((d) => d.id !== rid) }
  emit()
  void Promise.all([load('decisions'), load('inbox'), load('home')])
  const message =
    typeof out?.message === 'string'
      ? out.message
      : out?.status === 'open'
        ? 'Aprovação registrada. Falta a aprovação de outra pessoa.'
        : undefined
  return message ? { message } : {}
}

const SLUG_OK = /^[a-z0-9][a-z0-9_-]{0,79}$/

export async function agentDetail(slug: string): Promise<AgentDetail> {
  connected()
  if (!SLUG_OK.test(slug)) throw new Error('Agente inválido.')
  let raw: unknown
  try {
    raw = await platformGet<unknown>(`/api/agents/${slug}`)
  } catch (err) {
    throw actionError(err)
  }
  const detail = parseAgentDetail(raw)
  if (!detail) throw new Error('A plataforma devolveu um agente inválido.')
  return detail
}

/** Publishing tests every member and promotes: it can take minutes. */
const SHIP_TIMEOUT_MS = 15 * 60_000

export async function agentAction(slug: string, action: AgentAction): Promise<AgentActionResult> {
  connected()
  if (!SLUG_OK.test(slug)) throw new Error('Agente inválido.')
  let message: string
  try {
    switch (action) {
      case 'stop-stage':
      case 'stop-prod': {
        const env = action === 'stop-prod' ? 'prod' : 'stage'
        await platformSend('POST', `/api/agents/${slug}/stop`, { env })
        message = env === 'prod' ? 'Parado em produção.' : 'Parado em stage.'
        break
      }
      case 'ship': {
        const steps = await platformSend<unknown>(
          'POST',
          `/api/agents/${slug}/ship`,
          {},
          { timeoutMs: SHIP_TIMEOUT_MS }
        )
        const pending =
          Array.isArray(steps) &&
          steps.some((s) => s && typeof s === 'object' && (s as { status?: unknown }).status === 'approval_pending')
        message = pending
          ? 'Testado em stage. A publicação em produção aguarda a aprovação de quem pode promover.'
          : 'Testado e publicado em produção.'
        break
      }
      case 'delete':
        await platformSend('DELETE', `/api/agents/${slug}`)
        message = 'Agente excluído.'
        break
      case 'pause':
      case 'resume':
      case 'offboard': {
        const to = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'offboarded'
        await platformSend('POST', `/api/employees/${slug}/status`, { to, reason: 'pelo Hangar desktop' })
        message = action === 'pause' ? 'Pausado.' : action === 'resume' ? 'Retomado.' : 'Desligado.'
        break
      }
      default:
        throw new Error('Ação desconhecida.')
    }
  } catch (err) {
    throw actionError(err)
  }
  void Promise.all([load('home'), chartWanted ? load('chart') : Promise.resolve()])
  return { message }
}

// ---------------------------------------------------------------- events

function patchStatus(slug: string, status: string): void {
  const home = res.home.data
  if (home)
    res.home = {
      ...res.home,
      data: {
        ...home,
        agents: home.agents.map((a) => (a.slug === slug ? { ...a, status } : a)),
        builtAgents: home.builtAgents.map((a) => (a.slug === slug ? { ...a, status } : a))
      }
    }
  const chart = res.chart.data
  if (chart)
    res.chart = { ...res.chart, data: { nodes: chart.nodes.map((n) => (n.slug === slug ? { ...n, status } : n)) } }
}

/** Applies an event right away (badges move at once) and schedules a refresh for the details. */
export function applyEvent(e: WorkspaceEvent): void {
  switch (e.type) {
    case 'inbox.changed':
      res.inbox = {
        ...res.inbox,
        data: { ...(res.inbox.data ?? { all: 0, decisions: 0, blocked: 0 }), unread: e.unread }
      }
      break
    case 'decision.created': {
      const list = res.decisions.data
      // `agent` is a slug: the name comes from the person's agents when known (the refresh brings the rest).
      const agent = res.home.data?.agents.find((a) => a.slug === e.agent)
      if (list && !list.some((d) => d.id === e.id))
        res.decisions = {
          ...res.decisions,
          data: [
            {
              id: e.id,
              kind: 'approval',
              employee: agent?.slug,
              employeeName: agent?.name ?? e.agent ?? '',
              employeeTitle: '',
              question: e.title || undefined,
              mine: true,
              createdAt: new Date().toISOString(),
              approvals: 0,
              approvalsNeeded: 1
            },
            ...list
          ]
        }
      refreshSoon('home')
      break
    }
    case 'decision.decided':
      if (res.decisions.data)
        res.decisions = { ...res.decisions, data: res.decisions.data.filter((d) => d.id !== e.id) }
      refreshSoon('home')
      break
    case 'agent.status':
      patchStatus(e.slug, e.status)
      break
    case 'models.changed':
      void syncPlatformModels()
      return
    case 'task.updated':
      onTaskUpdated(e.id)
      return
  }
  emit()
}

/** The name of one of the person's agents or Digital employees (Meus agentes), for the session's task card. */
export function agentName(slug: string): string | undefined {
  return slug ? res.home.data?.agents.find((a) => a.slug === slug)?.name : undefined
}

function onMessage(msg: SseMessage): void {
  const e = parseEvent(msg.event, msg.data)
  if (e) applyEvent(e)
}

const stream = new EventStream({
  open: async (lastEventId, signal) => {
    const response = await platformStream(EVENTS_PATH, lastEventId ? { 'last-event-id': lastEventId } : {}, signal)
    return response.body
  },
  onMessage,
  onStatus: (status) => {
    if (!loginKey) return
    live = status
    emit()
  },
  poll: () => void refresh('all'),
  onReconnected: () => void refresh('all'),
  onError: maybeRecheck,
  unsupported: (err) => err instanceof PlatformError && err.code === 'not_found'
})

// ---------------------------------------------------------------- login changes

function onPlatform(state: PlatformState): void {
  const nextEnabled = state.status !== 'off'
  const login = platformLogin()
  const key = login ? `${login.url} ${login.userId}` : undefined
  firstName = login?.name.split(/[ @]/)[0] || undefined
  if (key === loginKey) {
    if (nextEnabled !== enabled) {
      enabled = nextEnabled
      emit()
    }
    return
  }
  enabled = nextEnabled
  stream.stop()
  if (eventTimer) clearTimeout(eventTimer)
  eventTimer = undefined
  pendingScopes = new Set()
  inflight.clear()
  chartWanted = false
  loginKey = key
  if (!key) {
    // Logged out (or another account next): nothing of the previous person stays on disk.
    res = empty()
    live = 'off'
    dropCache()
    emit()
    return
  }
  res = loadCache(key)
  live = 'connecting'
  stream.start()
  void refresh('all')
}

// ---------------------------------------------------------------- portal and navigation

/** Opens a screen of the portal in the browser (closed list of routes, on the configured platform only). */
export async function openPortal(target: PortalTarget, label?: string): Promise<boolean> {
  if (!validPortalTarget(target)) throw new Error('Tela do portal inválida.')
  const url = platformUrl()
  if (!url) return false
  const opened = await openExternalLink(`${url}/app${portalHash(target)}`)
  if (opened && label && (target.screen === 'agent' || target.screen === 'employee' || target.screen === 'task'))
    remember(target, label)
  if (opened && loginKey) emit()
  return opened
}

/** VS Code's Agent Hangar extension takes the employee as its worker in a folder of the person's choosing (the
 *  extension confirms first). The link is built here from the slug and the configured platform — never a URL from the
 *  renderer — since custom protocols are refused by openExternalLink. */
export async function openInVscode(slug: string): Promise<boolean> {
  const url = platformUrl()
  if (!url || !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) return false
  const query = new URLSearchParams({ employee: slug, url }).toString()
  await shell.openExternal(`vscode://agent-hangar.agent-hangar/work?${query}`)
  return true
}

/** Where a valid deep link leads: native screens show in the window, the rest open the portal. */
export function navigate(nav: WorkspaceNavigation): void {
  if ('portal' in nav) {
    if (!ctxRef) {
      queuedPortal.push(nav.portal)
      return
    }
    if (platformUrl()) {
      void openPortal(nav.portal)
      return
    }
    // No platform configured: the app's workspace explains how to connect.
    nav = { view: 'home' }
  }
  pendingNavigation = { nav, at: Date.now() }
  if (!ctxRef) return // the window that opens next takes it (takeNavigation)
  const win = ctxRef.mainWindow()
  if (!win) {
    // Before the first window (app starting) the app creates it as usual; afterwards (e.g. macOS with every
    // window closed) a deep link brings one back. Either way the new renderer takes the navigation.
    if (windowCreated) ctxRef.showMainWindow()
    return
  }
  // A window still loading shows itself when ready; its renderer may or may not listen yet, so the navigation
  // also stays for takeNavigation (taking it twice only opens the same screen again).
  if (!win.webContents.isLoading()) {
    pendingNavigation = undefined
    ctxRef.showMainWindow()
  }
  broadcast(WORKSPACE.evNavigate, nav)
}

/** The deep link that arrived before the renderer was ready (once). */
export function takeNavigation(): WorkspaceNavigation | undefined {
  const p = pendingNavigation
  pendingNavigation = undefined
  return p && Date.now() - p.at < NAVIGATION_TTL_MS ? p.nav : undefined
}

// ---------------------------------------------------------------- lifecycle

export function start(ctx: FeatureContext): void {
  ctxRef = ctx
  app.on('browser-window-created', () => (windowCreated = true))
  onPlatformState(onPlatform)
  onPlatform(platformState())
  powerMonitor.on('resume', () => {
    if (!loginKey) return
    stream.reconnect()
    void refresh('all')
  })
  for (const target of queuedPortal.splice(0)) navigate({ portal: target })
}

export function stop(): void {
  stream.stop()
  if (eventTimer) clearTimeout(eventTimer)
  if (saveTimer) clearTimeout(saveTimer)
}
