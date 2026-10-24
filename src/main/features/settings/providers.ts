// Provider profiles: storage, validation, launch resolution and the connection test.
//
// Profiles (no secrets) live in <userData>/hangar-data/settings/providers.json. Each profile's secret is
// encrypted with Electron's safeStorage (DPAPI on Windows) into providers.secrets.json and decrypted once
// into memory, so resolveProviderLaunch() can stay synchronous. Secrets never go back to the renderer,
// and every error text that could contain one goes through maskSecrets().
//
// Variable names follow the Claude Code docs (code.claude.com/docs/en/llm-gateway-connect, /amazon-bedrock,
// /google-vertex-ai, /microsoft-foundry, /env-vars, /model-config).

import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUBSCRIPTION_PROFILE_ID,
  type ProviderKind,
  type ProviderLaunch,
  type ProviderModels,
  type ProviderProfile
} from '../../../shared/providers'
import { SETTINGS, type ProviderInput, type ProvidersState, type ProviderTestResult } from '../../../shared/features/settings'
import { broadcast } from '../../core/broadcast'
import { settings } from '../../core/store'
import { loadSdk, resolveClaudeExecutable } from '../engine/sdk'

type StoredProfile = Omit<ProviderProfile, 'hasSecret'>

const SUBSCRIPTION_PROFILE: ProviderProfile = {
  id: SUBSCRIPTION_PROFILE_ID,
  name: 'Assinatura Claude (login do Claude Code)',
  kind: 'subscription',
  hasSecret: false,
  createdAt: 0,
  updatedAt: 0
}

const EDITABLE_KINDS: ProviderKind[] = ['subscription', 'anthropic', 'gateway', 'bedrock', 'vertex', 'foundry']

// ---- Variables a profile manages ----

/** Credentials of every kind; a profile clears the ones it doesn't set so nothing leaks between profiles. */
const AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN'
]

/** Endpoint and provider switches. */
const ROUTING_VARS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLOUD_ML_REGION',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH'
]

/** Alias mapping; another profile's mapping would point at models this provider doesn't serve. */
const MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL'
]

const MANAGED_VARS = [...AUTH_VARS, ...ROUTING_VARS, ...MODEL_VARS]

/** Names `extraEnv` may not set (also the AWS ones a bedrock profile sets from its fields). */
const PROTECTED_VARS = new Set([...MANAGED_VARS, 'AWS_REGION', 'AWS_PROFILE'])

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

// ---- Storage ----

let profiles: StoredProfile[] | undefined
/** id → base64 ciphertext, as stored on disk. */
let encrypted: Record<string, string> = {}
/** id → decrypted secret, in memory only. */
const secrets = new Map<string, string>()

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'settings')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const profilesFile = () => join(dataDir(), 'providers.json')
const secretsFile = () => join(dataDir(), 'providers.secrets.json')

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function ensureLoaded(): StoredProfile[] {
  if (profiles) return profiles
  profiles = readJson<StoredProfile[]>(profilesFile(), []).filter((p) => p && p.id && p.id !== SUBSCRIPTION_PROFILE_ID)
  encrypted = readJson<Record<string, string>>(secretsFile(), {})
  secrets.clear()
  if (safeStorage.isEncryptionAvailable()) {
    for (const [id, data] of Object.entries(encrypted)) {
      try {
        secrets.set(id, safeStorage.decryptString(Buffer.from(data, 'base64')))
      } catch {
        // Encrypted by another Windows user or machine: reported as "não foi possível decifrar" on use.
      }
    }
  }
  return profiles
}

/** Loads profiles and decrypts secrets; called at startup so the first launch doesn't pay for it. */
export function loadProviders(): void {
  ensureLoaded()
}

function persist(): void {
  writeJsonAtomic(profilesFile(), ensureLoaded())
  broadcast(SETTINGS.providersChanged)
}

function persistSecrets(): void {
  writeJsonAtomic(secretsFile(), encrypted)
  broadcast(SETTINGS.providersChanged)
}

const withSecretFlag = (p: StoredProfile): ProviderProfile => ({ ...p, hasSecret: p.id in encrypted })

export function listProviders(): ProviderProfile[] {
  return [SUBSCRIPTION_PROFILE, ...ensureLoaded().map(withSecretFlag)]
}

function defaultProviderId(): string {
  const id = settings().get().defaultProviderId
  return id && (id === SUBSCRIPTION_PROFILE_ID || ensureLoaded().some((p) => p.id === id)) ? id : SUBSCRIPTION_PROFILE_ID
}

export function providersState(): ProvidersState {
  const base = userSettingsEnv().ANTHROPIC_BASE_URL
  return {
    profiles: listProviders(),
    defaultId: defaultProviderId(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    userSettingsBaseUrl: typeof base === 'string' && base ? maskSecrets(base) : undefined
  }
}

function findStored(id: string): StoredProfile {
  const p = ensureLoaded().find((x) => x.id === id)
  if (!p) throw new Error(id === SUBSCRIPTION_PROFILE_ID ? 'O perfil da assinatura não pode ser alterado.' : 'Perfil não encontrado.')
  return p
}

// ---- Validation ----

const trimmed = (v: string | undefined) => {
  const t = v?.trim()
  return t ? t : undefined
}

function normalizeUrl(url: string | undefined, label: string): string | undefined {
  const t = trimmed(url)
  if (!t) return undefined
  let parsed: URL
  try {
    parsed = new URL(t)
  } catch {
    throw new Error(`${label}: URL inválida.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label}: use http:// ou https://.`)
  return t.replace(/\/+$/, '')
}

function normalizeModels(models: ProviderModels | undefined): ProviderModels | undefined {
  if (!models) return undefined
  const out: ProviderModels = {
    default: trimmed(models.default),
    opus: trimmed(models.opus),
    sonnet: trimmed(models.sonnet),
    haiku: trimmed(models.haiku)
  }
  const extra = [...new Set((models.extra ?? []).map((m) => m.trim()).filter(Boolean))].slice(0, 30)
  if (extra.length) out.extra = extra
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k as keyof ProviderModels]
  return Object.keys(out).length ? out : undefined
}

function normalizeExtraEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(env)) {
    const name = rawName.trim()
    if (!name) continue
    if (!ENV_NAME.test(name)) throw new Error(`Variável "${name}": use só letras maiúsculas, dígitos e _ (começando por letra).`)
    if (PROTECTED_VARS.has(name)) throw new Error(`Variável "${name}" é controlada pelo próprio perfil; use os campos dele.`)
    out[name] = String(value ?? '')
  }
  if (Object.keys(out).length > 40) throw new Error('Variáveis extras demais (máximo 40).')
  return Object.keys(out).length ? out : undefined
}

function validate(input: ProviderInput, existing?: StoredProfile): StoredProfile {
  if (!EDITABLE_KINDS.includes(input.kind)) throw new Error('Tipo de provedor inválido.')
  const name = trimmed(input.name)
  if (!name) throw new Error('Informe um nome.')
  if (name.length > 80) throw new Error('Nome longo demais.')
  const region = trimmed(input.region)
  if (region && !/^[a-z0-9-]+$/.test(region)) throw new Error('Região inválida (ex.: us-east-1, global).')
  const project = trimmed(input.project)
  const awsProfile = trimmed(input.awsProfile)
  if (awsProfile && !/^[\w.+@-]+$/.test(awsProfile)) throw new Error('Perfil AWS inválido.')
  const baseUrl = normalizeUrl(input.baseUrl, 'URL base')

  const p: StoredProfile = {
    id: existing?.id ?? `p_${randomUUID().slice(0, 8)}`,
    name,
    kind: input.kind,
    baseUrl,
    authStyle: input.kind === 'gateway' || input.kind === 'foundry' ? (input.authStyle === 'x-api-key' ? 'x-api-key' : 'bearer') : undefined,
    region: input.kind === 'bedrock' || input.kind === 'vertex' ? region : undefined,
    project: input.kind === 'vertex' || input.kind === 'foundry' ? project : undefined,
    awsProfile: input.kind === 'bedrock' ? awsProfile : undefined,
    models: normalizeModels(input.models),
    extraEnv: normalizeExtraEnv(input.extraEnv),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  }
  if (p.kind === 'gateway' && !p.baseUrl) throw new Error('Informe a URL base do gateway.')
  if (p.kind === 'vertex' && !p.project) throw new Error('Informe o ID do projeto GCP.')
  if (p.kind === 'foundry') {
    if (!p.project && !p.baseUrl) throw new Error('Informe o nome do recurso Foundry ou a URL base.')
    if (p.project && !/^[a-zA-Z0-9-]+$/.test(p.project)) throw new Error('Recurso Foundry: só o nome (ex.: my-resource), sem URL.')
  }
  for (const k of Object.keys(p) as (keyof StoredProfile)[]) if (p[k] === undefined) delete p[k]
  return p
}

// ---- CRUD ----

export function saveProvider(input: ProviderInput): ProviderProfile {
  if (input.id === SUBSCRIPTION_PROFILE_ID) throw new Error('O perfil da assinatura não pode ser alterado.')
  const list = ensureLoaded()
  const existing = input.id ? findStored(input.id) : undefined
  const p = validate(input, existing)
  profiles = existing ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]
  persist()
  return withSecretFlag(p)
}

export function deleteProvider(id: string): boolean {
  if (id === SUBSCRIPTION_PROFILE_ID) throw new Error('O perfil da assinatura não pode ser excluído.')
  const list = ensureLoaded()
  if (!list.some((p) => p.id === id)) return false
  profiles = list.filter((p) => p.id !== id)
  secrets.delete(id)
  if (id in encrypted) {
    delete encrypted[id]
    writeJsonAtomic(secretsFile(), encrypted)
  }
  if (settings().get().defaultProviderId === id) settings().patch({ defaultProviderId: SUBSCRIPTION_PROFILE_ID })
  persist()
  return true
}

export function setProviderSecret(id: string, secret: string): ProviderProfile {
  const p = findStored(id)
  const value = secret.trim()
  if (!value) throw new Error('A chave está vazia.')
  if (/[\r\n]/.test(value)) throw new Error('A chave não pode ter quebras de linha.')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('A criptografia do sistema (safeStorage/DPAPI) não está disponível, então o Hangar não salva chaves.')
  }
  encrypted[id] = safeStorage.encryptString(value).toString('base64')
  secrets.set(id, value)
  p.updatedAt = Date.now()
  writeJsonAtomic(profilesFile(), ensureLoaded())
  persistSecrets()
  return withSecretFlag(p)
}

export function clearProviderSecret(id: string): ProviderProfile {
  const p = findStored(id)
  delete encrypted[id]
  secrets.delete(id)
  p.updatedAt = Date.now()
  writeJsonAtomic(profilesFile(), ensureLoaded())
  persistSecrets()
  return withSecretFlag(p)
}

export function setDefaultProvider(id: string): void {
  if (id !== SUBSCRIPTION_PROFILE_ID) findStored(id)
  settings().patch({ defaultProviderId: id })
  broadcast(SETTINGS.providersChanged)
}

// ---- Masking ----

/** Replaces every stored secret (and anything shaped like an API key) in `text`. */
export function maskSecrets(text: string): string {
  let out = text
  for (const s of secrets.values()) {
    if (s.length >= 4) out = out.split(s).join('••••')
  }
  return out
    .replace(/\b(sk-[A-Za-z0-9]{0,6})[A-Za-z0-9_-]{6,}/g, '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••')
    .replace(/((?:x-api-key|api[_-]?key|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••')
}

// ---- Launch resolution ----

/** The `env` block of the user's Claude Code settings, which outranks the process environment. */
function userSettingsEnv(): Record<string, unknown> {
  const dir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  const env = readJson<{ env?: Record<string, unknown> }>(join(dir, 'settings.json'), {}).env
  return env && typeof env === 'object' ? env : {}
}

function requireSecret(p: StoredProfile): string {
  const s = secrets.get(p.id)
  if (s) return s
  if (p.id in encrypted) throw new Error(`Não foi possível decifrar a chave do perfil “${p.name}”. Salve a chave de novo em Configurações → Provedores.`)
  throw new Error(`O perfil “${p.name}” não tem chave salva. Abra Configurações → Provedores.`)
}

export function resolveLaunch(profileId?: string): ProviderLaunch {
  ensureLoaded()
  const wanted = profileId ?? defaultProviderId()
  // A session may still point at a deleted profile: fall back to the default, then the subscription.
  const p = ensureLoaded().find((x) => x.id === wanted) ?? (wanted !== SUBSCRIPTION_PROFILE_ID ? ensureLoaded().find((x) => x.id === defaultProviderId()) : undefined)
  if (!p) return { env: {}, unset: ['ANTHROPIC_API_KEY'], settingsEnv: {} }

  const set: Record<string, string> = {}
  const secretVars: Record<string, string> = {}
  switch (p.kind) {
    case 'subscription':
      // A user-made subscription profile: the Claude Code login, but on an explicit endpoint (default: Anthropic
      // directly), overriding a gateway the user's ~/.claude/settings.json points at.
      set.ANTHROPIC_BASE_URL = p.baseUrl || 'https://api.anthropic.com'
      break
    case 'anthropic':
      secretVars.ANTHROPIC_API_KEY = requireSecret(p)
      set.ANTHROPIC_BASE_URL = p.baseUrl ?? 'https://api.anthropic.com'
      break
    case 'gateway':
      set.ANTHROPIC_BASE_URL = p.baseUrl!
      secretVars[p.authStyle === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = requireSecret(p)
      break
    case 'bedrock':
      set.CLAUDE_CODE_USE_BEDROCK = '1'
      if (p.region) set.AWS_REGION = p.region
      if (p.awsProfile) set.AWS_PROFILE = p.awsProfile
      if (p.baseUrl) set.ANTHROPIC_BEDROCK_BASE_URL = p.baseUrl
      if (secrets.has(p.id)) secretVars.AWS_BEARER_TOKEN_BEDROCK = requireSecret(p)
      break
    case 'vertex':
      set.CLAUDE_CODE_USE_VERTEX = '1'
      if (p.region) set.CLOUD_ML_REGION = p.region
      if (p.project) set.ANTHROPIC_VERTEX_PROJECT_ID = p.project
      if (p.baseUrl) set.ANTHROPIC_VERTEX_BASE_URL = p.baseUrl
      break
    case 'foundry':
      set.CLAUDE_CODE_USE_FOUNDRY = '1'
      if (p.project) set.ANTHROPIC_FOUNDRY_RESOURCE = p.project
      else if (p.baseUrl) set.ANTHROPIC_FOUNDRY_BASE_URL = p.baseUrl
      // Without a key Claude Code uses the Azure default credential chain (az login).
      if (secrets.has(p.id)) secretVars[p.authStyle === 'bearer' ? 'ANTHROPIC_FOUNDRY_AUTH_TOKEN' : 'ANTHROPIC_FOUNDRY_API_KEY'] = requireSecret(p)
      break
  }
  if (p.models?.opus) set.ANTHROPIC_DEFAULT_OPUS_MODEL = p.models.opus
  if (p.models?.sonnet) set.ANTHROPIC_DEFAULT_SONNET_MODEL = p.models.sonnet
  if (p.models?.haiku) set.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.models.haiku
  for (const [name, value] of Object.entries(p.extraEnv ?? {})) {
    if (ENV_NAME.test(name) && !PROTECTED_VARS.has(name) && !(name in set)) set[name] = value
  }

  const env = { ...set, ...secretVars }
  // The subscription login itself (a setup-token in CLAUDE_CODE_OAUTH_TOKEN) must survive a subscription profile.
  const unset = MANAGED_VARS.filter((name) => !(name in env) && !(p.kind === 'subscription' && name === 'CLAUDE_CODE_OAUTH_TOKEN'))
  // Flag settings outrank ~/.claude/settings.json (where this machine, for example, points ANTHROPIC_BASE_URL at a
  // local gateway). The SDK applies them over its stdio control channel, not the command line.
  const settingsEnv: Record<string, string> = { ...env }
  const fromUserSettings = userSettingsEnv()
  for (const name of unset) if (name in fromUserSettings) settingsEnv[name] = ''
  return { env, unset, settingsEnv, defaultModel: p.models?.default }
}

// ---- Connection test ----

const TEST_TIMEOUT_MS = 90_000

/** Plain-language reading of the SDK's assistant error codes. */
const ERROR_HINT: Record<string, string> = {
  authentication_failed: 'credencial recusada — confira a chave/token e o tipo de autenticação',
  billing_error: 'problema de cobrança na conta do provedor',
  rate_limit: 'limite de requisições atingido',
  overloaded: 'provedor sobrecarregado',
  invalid_request: 'requisição rejeitada — o endpoint pode não ser compatível com a API de Mensagens',
  model_not_found: 'modelo não encontrado neste provedor — confira o mapeamento de modelos',
  server_error: 'erro no servidor do provedor/gateway',
  cloud_credential_error: 'credenciais da nuvem ausentes ou expiradas',
  unknown: 'sem resposta (conexão recusada, DNS ou timeout)'
}

export async function testProvider(id: string): Promise<ProviderTestResult> {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  let launch: ProviderLaunch
  try {
    if (id !== SUBSCRIPTION_PROFILE_ID) findStored(id)
    launch = resolveLaunch(id)
  } catch (err) {
    return { ok: false, latencyMs: 0, error: maskSecrets(err instanceof Error ? err.message : String(err)) }
  }
  const model = launch.defaultModel ?? 'haiku'

  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of launch.unset) delete env[name]
  Object.assign(env, launch.env, { CLAUDE_AGENT_SDK_CLIENT_APP: 'hangar/0.1.0' })

  const abort = new AbortController()
  let failure: string | undefined
  let answeredModel: string | undefined
  let reply = ''
  const timer = setTimeout(() => {
    failure ??= `Tempo esgotado (${TEST_TIMEOUT_MS / 1000} s) sem resposta do provedor.`
    abort.abort()
  }, TEST_TIMEOUT_MS)

  try {
    const sdk = await loadSdk()
    const q = sdk.query({
      prompt: 'Responda apenas: ok',
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        env,
        settings: Object.keys(launch.settingsEnv).length ? { env: launch.settingsEnv } : undefined,
        model,
        maxTurns: 1,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        abortController: abort
      }
    })
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        answeredModel ??= msg.model
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        // Unreachable endpoints are retried with backoff for minutes; two failures are enough for a test.
        const hint = ERROR_HINT[msg.error] ?? msg.error
        failure = msg.error_status ? `O provedor respondeu HTTP ${msg.error_status}: ${hint}.` : `Não foi possível conectar ao endpoint: ${ERROR_HINT.unknown}.`
        if (msg.attempt >= 2) {
          abort.abort()
          break
        }
      } else if (msg.type === 'assistant') {
        answeredModel = msg.message.model || answeredModel
        if (msg.error) failure = `Erro do provedor: ${ERROR_HINT[msg.error] ?? msg.error}.`
        for (const block of msg.message.content) if (block.type === 'text') reply += block.text
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) {
          failure = undefined
          reply = msg.result || reply
        } else {
          const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n')
          failure = text?.trim() || failure || 'A consulta terminou com erro.'
        }
        break
      }
    }
    q.close()
  } catch (err) {
    if (!failure) failure = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }

  if (failure) return { ok: false, model: answeredModel ?? model, latencyMs: elapsed(), error: maskSecrets(failure) }
  return { ok: true, model: answeredModel ?? model, latencyMs: elapsed(), reply: maskSecrets(reply.trim().slice(0, 200)) }
}
