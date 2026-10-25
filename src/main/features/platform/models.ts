// Synced token models (docs/platform/app-api-models.md), the runtime part: GET /api/app/models → one managed
// provider profile per connection (settings/providers.ts keeps them and their secret), the device's LLM key
// (`ahl_…`, rotated when the proxy refuses it), sessions moved to the subscription when their profile goes away,
// and the model choice of a session or of new sessions.
//
// The catalog of the last sync is kept in <userData>/hangar-data/platform/models.json (no secrets): the picker
// shows names, context and prices from it while offline.
import { DEFAULT_SETTINGS } from '../../../shared/contracts'
import type { ModelChoice, PlatformConnection, PlatformModels } from '../../../shared/features/platform'
import { SUBSCRIPTION_PROFILE_ID } from '../../../shared/providers'
import { bus } from '../../core/bus'
import { db, settings } from '../../core/store'
import {
  closeSession,
  interrupt,
  noteSession,
  sessionState,
  setSessionModel,
  switchSessionProvider
} from '../engine/api'
import {
  listProviders,
  managedProviderSecret,
  managedProviders,
  setDefaultProvider,
  syncManagedProviders,
  type ManagedSyncResult
} from '../settings/providers'
import { parseModels, planFallback, profileFor, type Catalog, type RemovedProfile } from './catalog'
import type { ApiClient } from './client'
import { PlatformError, errorMessage } from './errors'
import type { FetchFn } from './oauth'
import { readJson, removeFile, writeJson } from './storage'

/** What this module needs from the connection (set by the controller). */
export interface ModelsHost {
  client: ApiClient
  fetch: FetchFn
  /** Platform URL of the current login, undefined when logged out. */
  url(): string | undefined
  deviceId(): string
  /** Broadcasts the platform state again. */
  emit(): void
}

interface StoredCatalog extends Catalog {
  url: string
  syncedAt: number
}

const CATALOG = 'models.json'
/** Errors that end the login: the controller handles them. */
const LOGIN_ERRORS = new Set(['session_expired', 'not_connected', 'revoked'])
const KEY_CHECK_INTERVAL_MS = 60_000

let host: ModelsHost | undefined
let stored: StoredCatalog | null | undefined
let status: PlatformModels['status'] = 'none'
let lastError: string | undefined
let lastKeyCheck = 0
/** Sessions whose Claude Code process still has the previous device key: restarted when their turn ends. */
const restartAfterTurn = new Set<string>()

function catalog(): StoredCatalog | undefined {
  if (stored === undefined) stored = readJson<StoredCatalog | null>(CATALOG, null)
  return stored ?? undefined
}

export function configureModels(h: ModelsHost): void {
  host = h
  // A failed turn on a managed profile may be the proxy refusing the device key: check it (and rotate it).
  bus.on('session:turn-ended', ({ sessionId, result }: { sessionId: string; result: 'success' | 'error' }) => {
    if (restartAfterTurn.delete(sessionId)) setTimeout(() => void closeSession(sessionId), 0)
    if (result !== 'error') return
    const s = db('sessions').get(sessionId)
    const profileId = s?.providerId || settings().get().defaultProviderId
    if (managedProviders().some((p) => p.id === profileId)) void checkKey()
  })
}

export function modelsView(): PlatformModels {
  const url = host?.url()
  const c = catalog()
  const current = !!url && c?.url === url
  return {
    status: status === 'none' && current ? 'ok' : status,
    version: current ? c.version : undefined,
    syncedAt: current ? c.syncedAt : undefined,
    error: lastError,
    connections: current ? c.connections : []
  }
}

/** The managed profiles as they are now, for the transcript notes if they go away. */
function snapshot(): RemovedProfile[] {
  const names = new Map((catalog()?.connections ?? []).map((c) => [c.profileId, c.name]))
  return managedProviders().map((p) => ({
    profileId: p.id,
    name: names.get(p.id) ?? p.name.replace(/^Plataforma · /, ''),
    modelIds: [p.models?.default, ...(p.models?.extra ?? [])].filter((m): m is string => !!m)
  }))
}

/** Moves sessions off removed profiles (docs: "sessões que os usavam caem para a assinatura com aviso"). */
async function fallback(
  result: ManagedSyncResult,
  before: RemovedProfile[],
  defaultBefore: string,
  reason: string
): Promise<void> {
  if (!result.removed.length) return
  const removed = before.filter((p) => result.removed.includes(p.profileId))
  const defaultFrom = result.defaultReset ? defaultBefore : undefined
  if (defaultFrom && removed.some((p) => p.modelIds.includes(settings().get().defaultModel)))
    settings().patch({ defaultModel: DEFAULT_SETTINGS.defaultModel })
  for (const step of planFallback(db('sessions').list(), removed, defaultFrom, reason)) {
    // The Claude Code process still has the old profile's environment: end it (the next prompt resumes).
    if (sessionState(step.sessionId).busy) await interrupt(step.sessionId).catch(() => undefined)
    await closeSession(step.sessionId)
    if (Object.keys(step.patch).length) db('sessions').patch(step.sessionId, step.patch)
    if (step.note) noteSession(step.sessionId, step.note)
  }
}

async function applyProfiles(
  url: string,
  connections: PlatformConnection[],
  secret: string | undefined,
  reason: string
) {
  const before = snapshot()
  const defaultBefore = settings().get().defaultProviderId
  const result = await syncManagedProviders(
    connections.map((c) => profileFor(url, c)),
    secret
  )
  await fallback(result, before, defaultBefore, reason)
}

/** Generates (or rotates: the previous one stops working) the device's key for the LLM proxy. */
async function createKey(h: ModelsHost): Promise<string> {
  const res = await h.client.request<{ key?: unknown }>(
    'POST',
    `/api/app/devices/${encodeURIComponent(h.deviceId())}/llm-key`
  )
  const key = typeof res.key === 'string' ? res.key.trim() : ''
  if (!key || /\s/.test(key))
    throw new PlatformError('http', 'A plataforma não devolveu a chave de LLM deste dispositivo.')
  return key
}

/** Whether the proxy refuses the stored key (401); other answers (403, 429, network) say nothing about the key. */
async function keyRefused(h: ModelsHost, url: string, c: PlatformConnection, key: string): Promise<boolean> {
  try {
    const res = await h.fetch(`${url}${c.basePath}/v1/models`, {
      headers: { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    await res.body?.cancel().catch(() => undefined)
    return res.status === 401
  } catch {
    return false
  }
}

/** Claude Code reads the key from its environment at start: processes on managed profiles restart with the new one. */
async function restartManagedRunners(): Promise<void> {
  const ids = new Set(managedProviders().map((p) => p.id))
  const fallbackId = settings().get().defaultProviderId
  for (const s of db('sessions').list()) {
    const state = sessionState(s.id)
    if (!state.running || !ids.has(s.providerId || fallbackId)) continue
    if (state.busy) restartAfterTurn.add(s.id)
    else await closeSession(s.id)
  }
}

/** Rotates the device key once when the proxy answers 401 to it. */
async function checkKey(force = false): Promise<void> {
  const h = host
  const url = h?.url()
  const c = catalog()
  const key = managedProviderSecret()
  if (!h || !url || c?.url !== url || !c.connections.length || !key) return
  if (!force && Date.now() - lastKeyCheck < KEY_CHECK_INTERVAL_MS) return
  lastKeyCheck = Date.now()
  if (!(await keyRefused(h, url, c.connections[0], key))) return
  try {
    const fresh = await createKey(h)
    await applyProfiles(url, c.connections, fresh, 'a chave do dispositivo foi trocada')
    await restartManagedRunners()
  } catch (err) {
    lastError = `A chave de LLM deste dispositivo foi recusada e não pôde ser renovada: ${errorMessage(err)}`
    status = 'error'
    h.emit()
  }
}

/**
 * GET /api/app/models and the managed profiles that follow from it. Login errors are thrown (the controller logs
 * out); any other failure keeps the previous profiles and is shown in the state.
 */
export async function syncModels(): Promise<void> {
  const h = host
  const url = h?.url()
  if (!h || !url) return
  status = 'syncing'
  h.emit()
  try {
    let next: Catalog
    let unsupported = false
    try {
      next = parseModels(await h.client.request<unknown>('GET', '/api/app/models'))
    } catch (err) {
      // An older platform without synced models.
      if (!(err instanceof PlatformError && err.code === 'not_found')) throw err
      next = { connections: [] }
      unsupported = true
    }
    if (h.url() !== url) return
    let secret: string | undefined
    let fresh = false
    if (next.connections.length) {
      secret = managedProviderSecret()
      if (!secret) {
        secret = await createKey(h)
        fresh = true
      }
    }
    stored = { ...next, url, syncedAt: Date.now() }
    writeJson(CATALOG, stored)
    await applyProfiles(url, next.connections, secret, 'a conexão deixou de ser sincronizada pela plataforma')
    status = unsupported ? 'unsupported' : 'ok'
    lastError = undefined
    if (!fresh) await checkKey(true)
  } catch (err) {
    if (err instanceof PlatformError && LOGIN_ERRORS.has(err.code)) {
      status = 'none'
      throw err
    }
    status = 'error'
    lastError = `Não foi possível sincronizar os modelos de token: ${errorMessage(err)}`
  }
}

/** Logged out (or the platform turned off): every managed profile goes, sessions on them fall back. */
export async function dropModels(reason: string): Promise<void> {
  stored = null
  removeFile(CATALOG)
  status = 'none'
  lastError = undefined
  try {
    await applyProfiles('', [], undefined, reason)
  } catch (err) {
    console.error('[platform] managed profiles could not be removed', err)
  }
}

// ---------------------------------------------------------------- model choice

function validChoice(choice: ModelChoice): ModelChoice {
  const providerId = typeof choice?.providerId === 'string' ? choice.providerId : ''
  const model = typeof choice?.model === 'string' ? choice.model.trim() : ''
  if (!listProviders().some((p) => p.id === providerId)) throw new Error('Perfil de provedor não encontrado.')
  if (!model || model.length > 200 || /\s/.test(model)) throw new Error('Modelo inválido.')
  return { providerId, model }
}

/**
 * Runs a session on a provider profile + model. Same profile: only the model changes (live, like the composer
 * always did). Another profile: a session that never ran just takes it; one with history switches like
 * engine:setProvider (the Claude Code process ends and the next message resumes the conversation).
 */
export async function chooseModel(sessionId: string, choice: ModelChoice): Promise<void> {
  const s = db('sessions').get(sessionId)
  if (!s) throw new Error('Sessão não encontrada.')
  const { providerId, model } = validChoice(choice)
  const current = s.providerId || settings().get().defaultProviderId || SUBSCRIPTION_PROFILE_ID
  if (current === providerId) return setSessionModel(sessionId, model)
  if (sessionState(sessionId).busy) throw new Error('Pare a geração antes de trocar de provedor.')
  if (!s.sdkSessionId) {
    await closeSession(sessionId)
    db('sessions').patch(sessionId, { providerId, model })
    return
  }
  switchSessionProvider(sessionId, providerId)
  await setSessionModel(sessionId, model)
}

/** Provider profile and model of new sessions (Configurações → Geral). */
export function setDefaultModel(choice: ModelChoice): void {
  const { providerId, model } = validChoice(choice)
  setDefaultProvider(providerId)
  settings().patch({ defaultModel: model })
}
