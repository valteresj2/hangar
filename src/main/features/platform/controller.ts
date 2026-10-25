// Connection to the Agent Hangar platform: effective config (Windows policy over the app's own choice), login,
// device registration, heartbeat, synced token models (./models.ts) and logout. Every change is broadcast as
// PlatformState.
import { app, net, Notification, powerMonitor } from 'electron'
import { randomUUID } from 'node:crypto'
import { hostname, release } from 'node:os'
import {
  PLATFORM,
  type PlatformConfig,
  type PlatformConfigPatch,
  type PlatformDevice,
  type PlatformMode,
  type PlatformNotice,
  type PlatformOrg,
  type PlatformState,
  type PlatformStatus,
  type PlatformUser,
  type PlatformValueSource
} from '../../../shared/features/platform'
import { broadcast } from '../../core/broadcast'
import type { FeatureContext } from '../../core/feature'
import { openExternalLink } from '../../core/window'
import { ApiClient, TokenManager } from './client'
import { PlatformError, errorMessage, hostOf } from './errors'
import { configureModels, dropModels, modelsView, syncModels } from './models'
import { login, revokeTokens, type FetchFn, type TokenSet } from './oauth'
import { normalizeUrl, parseMode, readPolicy, type Policy } from './policy'
import { clearTokens, loadTokens, readJson, removeFile, saveTokens, writeJson } from './storage'

export const HEARTBEAT_MS = 15 * 60_000
const DEFAULT_MODE: PlatformMode = 'optional'

interface StoredConfig {
  url?: string
  mode?: PlatformMode
}

interface StoredDevice {
  deviceId: string
  /** `${platformUrl} ${userId}` the device was last registered for. */
  registeredFor?: string
  registeredAt?: number
  lastSeenAt?: number
  status?: 'active' | 'revoked'
}

interface StoredAccount {
  url: string
  user: PlatformUser
  org?: PlatformOrg
  platformVersion?: string
}

interface MeResponse {
  user: {
    id: string | number
    email: string
    name?: string
    avatar_url?: string | null
    org_role?: string
    teams?: { id: string | number; slug: string; name: string }[]
  }
  org?: { id: string | number; name: string; slug: string } | null
  platform?: { version?: string }
}

interface DeviceResponse {
  device: { device_id: string; status?: string; created_at?: string; last_seen_at?: string }
}

/** Main-process fetch through Chromium's network stack (system proxy, corporate certificates), no cookies. */
const fetchFn: FetchFn = (url, init) => net.fetch(url, { ...init, credentials: 'omit' })

const tokens = new TokenManager(fetchFn, { save: saveTokens })
const client = new ApiClient(fetchFn, tokens)

let ctxRef: FeatureContext | undefined
let policy: Policy = {}
let status: PlatformStatus = 'disconnected'
let account: StoredAccount | undefined
let lastError: string | undefined
let notice: PlatformNotice | undefined
let lastHeartbeatAt: number | undefined
let loginAbort: AbortController | undefined
let heartbeatTimer: NodeJS.Timeout | undefined
let syncing: Promise<void> | undefined

// ---------------------------------------------------------------- config

function storedConfig(): StoredConfig {
  return readJson<StoredConfig>('config.json', {})
}

export function effectiveConfig(): PlatformConfig {
  const stored = storedConfig()
  const userUrl = normalizeUrl(stored.url)
  const userMode = parseMode(stored.mode)
  const scope = (s: 'machine' | 'user'): PlatformValueSource => (s === 'machine' ? 'policy-machine' : 'policy-user')
  return {
    url: policy.url?.value ?? userUrl ?? '',
    mode: policy.mode?.value ?? userMode ?? DEFAULT_MODE,
    source: {
      url: policy.url ? scope(policy.url.scope) : userUrl ? 'user' : 'default',
      mode: policy.mode ? scope(policy.mode.scope) : userMode ? 'user' : 'default'
    },
    locked: { url: !!policy.url, mode: !!policy.mode }
  }
}

const isLoopbackHost = (url: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Tokens travel to this URL: plain http only for the local machine. */
function checkUrl(url: string): void {
  if (url.startsWith('http://') && !isLoopbackHost(url))
    throw new PlatformError('config', 'Use um endereço https:// (http:// só é aceito para localhost).')
}

// ---------------------------------------------------------------- device

function device(): StoredDevice {
  const stored = readJson<Partial<StoredDevice>>('device.json', {})
  if (stored.deviceId && /^[0-9a-f-]{36}$/i.test(stored.deviceId)) return stored as StoredDevice
  const created: StoredDevice = { deviceId: randomUUID() }
  writeJson('device.json', created)
  return created
}

function patchDevice(patch: Partial<StoredDevice>): void {
  writeJson('device.json', { ...device(), ...patch })
}

const deviceName = () => hostname() || 'Windows'
const appVersion = () => app.getVersion()
const channel = () => /-(\w+)/.exec(appVersion())?.[1] ?? 'latest'
const osName = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')

function deviceView(): PlatformDevice {
  const d = device()
  const ts = (t: TokenSet | undefined) => (t && account ? `${t.url} ${account.user.id}` : undefined)
  const registered = !!d.registeredFor && d.registeredFor === ts(tokens.current)
  return {
    deviceId: d.deviceId,
    name: deviceName(),
    status: d.status === 'revoked' ? 'revoked' : registered ? 'active' : 'unregistered',
    registeredAt: registered ? d.registeredAt : undefined,
    lastSeenAt: d.lastSeenAt
  }
}

// ---------------------------------------------------------------- state

export function connected(): boolean {
  const t = tokens.current
  return !!t && t.url === effectiveConfig().url && (status === 'connected' || status === 'error')
}

export function getState(): PlatformState {
  const config = effectiveConfig()
  const current: PlatformStatus =
    config.mode === 'off'
      ? 'off'
      : status === 'connecting'
        ? 'connecting'
        : !config.url
          ? 'unconfigured'
          : tokens.current
            ? status === 'error'
              ? 'error'
              : 'connected'
            : 'disconnected'
  const showAccount = current === 'connected' || current === 'error'
  return {
    config,
    status: current,
    user: showAccount ? account?.user : undefined,
    org: showAccount ? account?.org : undefined,
    platformVersion: showAccount ? account?.platformVersion : undefined,
    device: deviceView(),
    error: lastError,
    notice,
    lastHeartbeatAt,
    canCreateSessions: config.mode !== 'required' || connected(),
    models: showAccount ? modelsView() : { status: 'none', connections: [] }
  }
}

const stateListeners = new Set<(state: PlatformState) => void>()

/** Main-side listeners of the platform state (other features, through ./api.ts). */
export function onStateChange(listener: (state: PlatformState) => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function emit(): PlatformState {
  const s = getState()
  broadcast(PLATFORM.evState, s)
  for (const listener of stateListeners) {
    try {
      listener(s)
    } catch (err) {
      console.error('[platform] state listener failed', err)
    }
  }
  return s
}

/** The app API client of the current login (other features call member routes through ./api.ts). */
export const apiClient = client

/** Platform URL and user of the current login, when logged in. */
export function currentLogin(): { url: string; userId: string; name: string } | undefined {
  const t = tokens.current
  if (!t || !connected()) return undefined
  return { url: t.url, userId: account?.url === t.url ? account.user.id : '', name: account?.user.name ?? '' }
}

function notify(tone: PlatformNotice['tone'], message: string, desktop = false): void {
  notice = { tone, message, at: Date.now() }
  if (desktop && Notification.isSupported()) new Notification({ title: 'Hangar · Plataforma', body: message }).show()
}

// ---------------------------------------------------------------- platform calls

function applyMe(me: MeResponse, url: string): void {
  const u = me.user
  account = {
    url,
    user: {
      id: String(u.id),
      email: u.email,
      name: u.name || u.email,
      avatarUrl: u.avatar_url || undefined,
      orgRole: u.org_role,
      teams: (u.teams ?? []).map((t) => ({ id: String(t.id), slug: t.slug, name: t.name }))
    },
    org: me.org ? { id: String(me.org.id), name: me.org.name, slug: me.org.slug } : undefined,
    platformVersion: me.platform?.version
  }
  writeJson('account.json', account)
}

async function registerDevice(): Promise<void> {
  const t = tokens.current
  if (!t || !account) return
  const d = device()
  const res = await client.request<DeviceResponse>('POST', '/api/app/devices', {
    device_id: d.deviceId,
    name: deviceName(),
    os: osName(),
    os_version: release(),
    app_version: appVersion(),
    channel: channel()
  })
  if (res.device?.status === 'revoked') throw new PlatformError('revoked', 'Este dispositivo foi revogado.')
  patchDevice({ registeredFor: `${t.url} ${account.user.id}`, registeredAt: Date.now(), status: 'active' })
}

async function heartbeat(retried = false): Promise<void> {
  const d = device()
  let res: { status?: string }
  try {
    res = await client.request<{ status?: string }>(
      'POST',
      `/api/app/devices/${encodeURIComponent(d.deviceId)}/heartbeat`,
      { app_version: appVersion() }
    )
  } catch (err) {
    // The platform does not know this device (e.g. its database was reset): register again, once.
    if (err instanceof PlatformError && err.code === 'not_found' && !retried) {
      await registerDevice()
      return heartbeat(true)
    }
    throw err
  }
  lastHeartbeatAt = Date.now()
  patchDevice({ lastSeenAt: lastHeartbeatAt })
  if (res.status === 'revoked') throw new PlatformError('revoked', 'Este dispositivo foi revogado.')
}

/**
 * After a refused refresh: asks the heartbeat, with the old access token, whether the login ended because the
 * device (or its authorization) was revoked. The platform answers `revoked` for tokens of an ended grant.
 */
async function probeRevoked(t: TokenSet): Promise<boolean> {
  try {
    const res = await fetchFn(`${t.url}/api/app/devices/${encodeURIComponent(device().deviceId)}/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ app_version: appVersion() }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return false
    return ((await res.json()) as { status?: string }).status === 'revoked'
  } catch {
    return false
  }
}

/**
 * Local logout: forgets tokens and account, and removes the managed provider profiles (sessions on them fall back
 * to the subscription). `revoke` also tells the platform (user-initiated logout).
 */
async function dropLogin(revoke: boolean): Promise<void> {
  const t = tokens.current
  tokens.set(undefined)
  clearTokens()
  removeFile('account.json')
  account = undefined
  status = 'disconnected'
  lastHeartbeatAt = undefined
  stopHeartbeat()
  await dropModels('o Hangar foi desconectado da plataforma')
  if (t && revoke) await revokeTokens(t, fetchFn)
}

/** What a failed platform call means for the connection. */
async function handleFailure(err: unknown): Promise<void> {
  const code = err instanceof PlatformError ? err.code : undefined
  const revoked = async () => {
    patchDevice({ status: 'revoked' })
    await dropLogin(false)
    lastError = undefined
    notify('error', 'Este dispositivo foi revogado na plataforma. O Hangar foi desconectado.', true)
  }
  if (code === 'revoked') return revoked()
  if (code === 'forbidden') {
    // Device revoked by the admin (registration refused) or user without access: the login is useless.
    await dropLogin(true)
    lastError = undefined
    notify('error', `${errorMessage(err).replace(/\.?$/, '.')} O Hangar foi desconectado.`, true)
    return
  }
  if (code === 'session_expired' || code === 'not_connected') {
    const t = tokens.current
    if (t && (await probeRevoked(t))) return revoked()
    await dropLogin(false)
    lastError = undefined
    if (t) notify('warn', 'Sua sessão na plataforma expirou ou foi revogada. Conecte de novo.', true)
    return
  }
  // Network or server trouble: keep the login, show the error, try again on the next heartbeat.
  status = 'error'
  lastError = errorMessage(err)
}

/** /me (+ device registration when needed) + heartbeat. Concurrent calls share one run. */
function sync(): Promise<void> {
  if (syncing) return syncing
  const run = (async () => {
    const t = tokens.current
    if (!t) return
    try {
      // Heartbeat first when the device is registered: it reports a revocation even when /me would only say 401.
      const registered = deviceView().status === 'active'
      if (registered) await heartbeat()
      const me = await client.request<MeResponse>('GET', '/api/app/me')
      // Logged out (or into another platform) while /me was in flight.
      if (tokens.current?.url !== t.url) return
      applyMe(me, t.url)
      if (!registered || deviceView().status !== 'active') {
        await registerDevice()
        await heartbeat()
      }
      status = 'connected'
      lastError = undefined
      await syncModels()
    } catch (err) {
      await handleFailure(err)
    }
  })()
  syncing = run
  void run.finally(() => {
    if (syncing === run) syncing = undefined
    emit()
  })
  return run
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => void sync(), HEARTBEAT_MS)
  heartbeatTimer.unref()
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
}

// ---------------------------------------------------------------- public actions

export async function start(ctx: FeatureContext): Promise<void> {
  ctxRef = ctx
  configureModels({
    client,
    fetch: fetchFn,
    url: () => tokens.current?.url,
    deviceId: () => device().deviceId,
    emit
  })
  policy = await readPolicy().catch(() => ({}))
  const stored = await loadTokens().catch(() => undefined)
  const config = effectiveConfig()
  const cached = readJson<StoredAccount | undefined>('account.json', undefined)
  if (stored && (stored.url !== config.url || config.mode === 'off')) {
    // The URL changed (e.g. by policy) or the platform was turned off since the last run.
    tokens.set(stored)
    await dropLogin(true)
  } else if (stored) {
    tokens.set(stored)
    account = cached?.url === stored.url ? cached : undefined
    status = 'connected'
    startHeartbeat()
    void sync()
  } else {
    // Not logged in: managed profiles left from an earlier login (e.g. tokens that no longer decrypt) go away.
    await dropModels('o Hangar não está conectado à plataforma')
  }
  powerMonitor.on('resume', () => {
    if (tokens.current) void sync()
  })
  emit()
}

export function stop(): void {
  stopHeartbeat()
  loginAbort?.abort()
}

export async function setConfig(patch: PlatformConfigPatch): Promise<PlatformState> {
  const before = effectiveConfig()
  const next: StoredConfig = { ...storedConfig() }
  if (patch.url !== undefined && !before.locked.url) {
    const text = patch.url.trim()
    const url = text ? normalizeUrl(text) : ''
    if (url === undefined)
      throw new PlatformError('config', 'URL inválida. Use o endereço da plataforma, com https://.')
    if (url) checkUrl(url)
    next.url = url
  }
  if (patch.mode !== undefined && !before.locked.mode) {
    const mode = parseMode(patch.mode)
    if (!mode) throw new PlatformError('config', 'Modo inválido.')
    next.mode = mode
  }
  writeJson('config.json', next)
  const after = effectiveConfig()
  if (tokens.current && (after.url !== tokens.current.url || after.mode === 'off')) {
    loginAbort?.abort()
    await dropLogin(true)
  }
  if (after.url !== before.url) lastError = undefined
  return emit()
}

export async function connect(): Promise<PlatformState> {
  if (loginAbort) throw new PlatformError('config', 'Já existe um login em andamento no navegador.')
  const config = effectiveConfig()
  if (config.mode === 'off') throw new PlatformError('config', 'A conexão com a plataforma está desligada (modo off).')
  if (!config.url) throw new PlatformError('config', 'Informe a URL da plataforma primeiro.')
  checkUrl(config.url)
  if (tokens.current) await dropLogin(true)

  const abort = new AbortController()
  loginAbort = abort
  status = 'connecting'
  lastError = undefined
  notice = undefined
  emit()
  try {
    const clients = readJson<Record<string, { clientId: string; registeredAt: number }>>('clients.json', {})
    const t = await login(config.url, {
      fetch: fetchFn,
      openBrowser: async (url) => {
        if (!(await openExternalLink(url))) throw new PlatformError('config', 'Não foi possível abrir o navegador.')
      },
      cachedClientId: clients[config.url]?.clientId,
      saveClientId: (clientId) => {
        const all = readJson<Record<string, { clientId: string; registeredAt: number }>>('clients.json', {})
        if (clientId) all[config.url] = { clientId, registeredAt: Date.now() }
        else delete all[config.url]
        writeJson('clients.json', all)
      },
      appVersion: appVersion(),
      signal: abort.signal
    })
    if (abort.signal.aborted || effectiveConfig().url !== config.url) {
      await revokeTokens(t, fetchFn)
      throw new PlatformError('canceled', 'Login cancelado.')
    }
    try {
      await saveTokens(t)
    } catch (err) {
      await revokeTokens(t, fetchFn)
      throw err
    }
    tokens.set(t)
    if (device().status === 'revoked') patchDevice({ status: undefined })
    status = 'connected'
    await sync()
    if (tokens.current) {
      startHeartbeat()
      if (!lastError) notify('info', `Conectado a ${account?.org?.name ?? hostOf(config.url)}.`)
    }
    ctxRef?.showMainWindow()
  } catch (err) {
    if (!tokens.current) status = 'disconnected'
    if (!(err instanceof PlatformError && err.code === 'canceled')) lastError = errorMessage(err)
  } finally {
    if (loginAbort === abort) loginAbort = undefined
    if (status === 'connecting') status = tokens.current ? 'connected' : 'disconnected'
  }
  return emit()
}

export function cancelConnect(): void {
  loginAbort?.abort()
}

export async function disconnect(): Promise<PlatformState> {
  loginAbort?.abort()
  await dropLogin(true)
  lastError = undefined
  notice = undefined
  return emit()
}

/** "Sincronizar agora": the synced token models only. */
export async function syncModelsNow(): Promise<PlatformState> {
  if (!connected()) throw new PlatformError('not_connected', 'Conecte o Hangar à plataforma primeiro.')
  try {
    await syncModels()
  } catch (err) {
    await handleFailure(err)
  }
  return emit()
}

export async function refresh(): Promise<PlatformState> {
  policy = await readPolicy().catch(() => policy)
  const config = effectiveConfig()
  if (tokens.current && (tokens.current.url !== config.url || config.mode === 'off')) await dropLogin(true)
  if (tokens.current) await sync()
  return emit()
}
