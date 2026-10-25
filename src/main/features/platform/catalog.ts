// Synced token models (docs/platform/app-api-models.md), the pure part: the platform's GET /api/app/models answer
// as the app keeps it, one managed provider profile per connection, and what happens to sessions whose profile
// disappears. No Electron here (unit-tested directly).
import type { Session } from '../../../shared/contracts'
import { managedProfileId, type PlatformConnection, type PlatformModel } from '../../../shared/features/platform'
import { SUBSCRIPTION_PROFILE_ID, type ProviderModels } from '../../../shared/providers'
import type { ManagedProfileInput } from '../settings/providers'

interface RawModel {
  model_id?: unknown
  name?: unknown
  context_length?: unknown
  caps?: unknown
  price_in_per_mtok?: unknown
  price_out_per_mtok?: unknown
}

interface RawConnection {
  id?: unknown
  name?: unknown
  provider?: unknown
  base_path?: unknown
  models?: unknown
}

export interface Catalog {
  version?: string
  connections: PlatformConnection[]
}

const MODEL_ID = /^[\w.:/@-]{1,200}$/
const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

function parseModel(raw: RawModel): PlatformModel | undefined {
  const id = text(raw.model_id, 200)
  if (!MODEL_ID.test(id)) return undefined
  const m: PlatformModel = { id, name: text(raw.name) || id }
  const context = positive(raw.context_length)
  if (context) m.contextLength = Math.round(context)
  if (Array.isArray(raw.caps)) {
    const caps = raw.caps.filter((c): c is string => typeof c === 'string').slice(0, 20)
    if (caps.length) m.caps = caps
  }
  const priceIn = positive(raw.price_in_per_mtok)
  const priceOut = positive(raw.price_out_per_mtok)
  if (priceIn !== undefined) m.priceInPerMTok = priceIn
  if (priceOut !== undefined) m.priceOutPerMTok = priceOut
  return m
}

/**
 * Validates the answer of GET /api/app/models. Connections without models are dropped (nothing to choose), and so
 * are those whose proxy path is not under /api/app/llm/ (the device key must never be sent anywhere else).
 */
export function parseModels(raw: unknown): Catalog {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { version?: unknown; connections?: unknown }
  const connections: PlatformConnection[] = []
  const list = Array.isArray(body.connections) ? (body.connections as RawConnection[]) : []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const id = typeof c.id === 'number' && Number.isInteger(c.id) && c.id > 0 ? c.id : undefined
    if (id === undefined || connections.some((x) => x.id === id)) continue
    const basePath = text(c.base_path, 300).replace(/\/+$/, '') || `/api/app/llm/${id}`
    if (!/^\/api\/app\/llm\/[\w-]+$/.test(basePath)) continue
    const models: PlatformModel[] = []
    for (const m of Array.isArray(c.models) ? (c.models as RawModel[]) : []) {
      const parsed = m && typeof m === 'object' ? parseModel(m) : undefined
      if (parsed && !models.some((x) => x.id === parsed.id)) models.push(parsed)
    }
    if (!models.length) continue
    connections.push({
      id,
      name: text(c.name) || `Conexão ${id}`,
      provider: text(c.provider, 40) || 'anthropic',
      basePath,
      profileId: managedProfileId(id),
      models: models.slice(0, 30)
    })
  }
  const version =
    typeof body.version === 'string' || typeof body.version === 'number' ? String(body.version) : undefined
  return { version, connections }
}

const ALIASES = ['opus', 'sonnet', 'haiku'] as const

/**
 * Model ids of a connection as a profile's models: the first is the default, and Claude Code's aliases (also used
 * for its background calls) map to a visible model of the same family, else to the default — the proxy refuses
 * models outside the visible list.
 */
export function profileModels(models: PlatformModel[]): ProviderModels {
  const ids = models.map((m) => m.id)
  const out: ProviderModels = { default: ids[0] }
  for (const alias of ALIASES) out[alias] = ids.find((id) => id.toLowerCase().includes(alias)) ?? ids[0]
  const extra = ids.slice(1)
  if (extra.length) out.extra = extra
  return out
}

/** The managed provider profile of a synced connection (docs/platform/app-api-models.md, "App"). */
export function profileFor(platformUrl: string, c: PlatformConnection): ManagedProfileInput {
  return {
    id: c.profileId,
    connectionId: c.id,
    name: `Plataforma · ${c.name}`,
    baseUrl: `${platformUrl.replace(/\/+$/, '')}${c.basePath}`,
    models: profileModels(c.models)
  }
}

export interface RemovedProfile {
  profileId: string
  /** Connection name, for the transcript note. */
  name: string
  modelIds: string[]
}

export interface FallbackStep {
  sessionId: string
  /** Empty when the session only needs its Claude Code process restarted (it follows the default). */
  patch: Partial<Session>
  /** Transcript note, when the session's provider or model changed. */
  note?: string
}

/**
 * What happens to sessions when managed profiles disappear. Sessions on one of them move to the subscription, with
 * its default model when theirs was a token model, and get a transcript note. Sessions without their own profile
 * that followed the removed default (`defaultResetFrom`) follow the subscription now: they move explicitly (with a
 * note) when their model was a token model, else they only restart.
 */
export function planFallback(
  sessions: Session[],
  removed: RemovedProfile[],
  defaultResetFrom: string | undefined,
  reason: string
): FallbackStep[] {
  const byProfile = new Map(removed.map((r) => [r.profileId, r]))
  const steps: FallbackStep[] = []
  for (const s of sessions) {
    const gone = byProfile.get(s.providerId || defaultResetFrom || '')
    if (!gone) continue
    const tokenModel = !!s.model && gone.modelIds.includes(s.model)
    if (!s.providerId && !tokenModel) {
      steps.push({ sessionId: s.id, patch: {} })
      continue
    }
    steps.push({
      sessionId: s.id,
      patch: { providerId: SUBSCRIPTION_PROFILE_ID, ...(tokenModel ? { model: undefined } : {}) },
      note: `Os modelos de token de “${gone.name}” não estão mais disponíveis (${reason}). A sessão passou a usar a assinatura Claude${tokenModel ? ', com o modelo padrão' : ''}; o histórico continua, mas o cache de prompt recomeça.`
    })
  }
  return steps
}
