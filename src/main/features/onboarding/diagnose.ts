// First-run / troubleshooting diagnosis: Claude Code executable, CLI login, endpoint overrides
// (the "gateway" in ~/.claude/settings.json or the environment), the default provider and git.
// Secret values are never read into results: credentials are reported by variable name only.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SUBSCRIPTION_PROFILE_ID, type ProviderProfile } from '../../../shared/providers'
import type {
  DiagnoseOptions,
  DiagnosticItem,
  DiagnosticReport,
  DirectFixResult,
  GatewayInfo
} from '../../../shared/features/onboarding'
import { settings } from '../../core/store'
import { resolveClaudeExecutable } from '../engine/sdk'
import { listProviders, maskSecrets, saveProvider, setDefaultProvider, testProvider } from '../settings/providers'
import { probe } from './probe'

const ANTHROPIC_API = 'https://api.anthropic.com'
const DIRECT_PROFILE_NAME = 'Assinatura (direto)'
const CREDENTIAL_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout = 30_000
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: homedir(), env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) || (err && !stdout ? err.message : '') })
    )
  })
}

/** Environment a session launch starts from: Hangar's own, without an API key (the subscription default). */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  return env
}

/** Shows a URL without query string or credentials, which could carry a token. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return maskSecrets(url)
  }
}

const isAnthropicApi = (url: string) => {
  try {
    return new URL(url).host === 'api.anthropic.com'
  } catch {
    return false
  }
}

// ---- Individual checks ----

async function checkClaude(): Promise<{ item: DiagnosticItem; exe?: string }> {
  const exe = resolveClaudeExecutable()
  const title = 'Claude Code'
  if (!exe) {
    return {
      item: {
        id: 'claude',
        title,
        status: 'warn',
        message:
          'O comando claude não foi encontrado no PATH nem em ~/.local/bin. O Hangar vai usar o executável embutido no SDK.',
        action: { kind: 'openUrl', label: 'Instalar o Claude Code', url: 'https://code.claude.com/docs/en/setup' }
      }
    }
  }
  const res = await run(exe, ['--version'], cliEnv(), 20_000)
  if (!res.ok) {
    return {
      exe,
      item: {
        id: 'claude',
        title,
        status: 'error',
        message: 'O executável do Claude Code foi encontrado mas não respondeu.',
        detail: `${exe}\n${maskSecrets(res.stderr.trim())}`
      }
    }
  }
  return { exe, item: { id: 'claude', title, status: 'ok', message: `Encontrado: ${res.stdout.trim()}.`, detail: exe } }
}

async function checkLogin(exe: string | undefined): Promise<DiagnosticItem> {
  const title = 'Login do Claude Code'
  if (!exe)
    return {
      id: 'login',
      title,
      status: 'skip',
      message: 'Sem o comando claude não dá para consultar o login; ele será verificado no teste do provedor.'
    }
  const res = await run(exe, ['auth', 'status', '--json'], cliEnv())
  const text = res.stdout.trim()
  try {
    const status = JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
    if (status.loggedIn !== true) {
      return {
        id: 'login',
        title,
        status: 'error',
        message: 'O Claude Code não está conectado. Abra um terminal, rode `claude` e entre com sua conta (/login).'
      }
    }
    const method = typeof status.authMethod === 'string' ? status.authMethod : 'credencial'
    const plan = typeof status.subscriptionType === 'string' ? ` (${status.subscriptionType})` : ''
    return {
      id: 'login',
      title,
      status: 'ok',
      message: method === 'claude.ai' ? `Conectado com a assinatura Claude${plan}.` : `Conectado (${method}).`
    }
  } catch {
    return {
      id: 'login',
      title,
      status: 'warn',
      message: 'Não foi possível ler o status de login (claude auth status).',
      detail: maskSecrets((res.stderr || text).trim()).slice(0, 400)
    }
  }
}

function claudeSettingsFile(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'settings.json')
}

/** ANTHROPIC_BASE_URL / credential names from the Windows user environment (registry), not just this process. */
async function windowsUserEnv(): Promise<{ baseUrl?: string; credentials: string[] }> {
  if (process.platform !== 'win32') return { credentials: [] }
  const query = (name: string) => run('reg', ['query', 'HKCU\\Environment', '/v', name], process.env, 10_000)
  const base = await query('ANTHROPIC_BASE_URL')
  const baseUrl = base.ok ? /ANTHROPIC_BASE_URL\s+REG_\w+\s+(.+)/.exec(base.stdout)?.[1]?.trim() : undefined
  const credentials: string[] = []
  for (const name of CREDENTIAL_VARS) {
    // Only the exit code is used: the value of a credential is never read.
    if ((await query(name)).ok) credentials.push(name)
  }
  return { baseUrl, credentials }
}

export async function gatewayInfo(): Promise<GatewayInfo> {
  let fileEnv: Record<string, unknown> = {}
  let apiKeyHelper = false
  try {
    const json = JSON.parse(readFileSync(claudeSettingsFile(), 'utf8')) as {
      env?: Record<string, unknown>
      apiKeyHelper?: unknown
    }
    if (json.env && typeof json.env === 'object') fileEnv = json.env
    apiKeyHelper = typeof json.apiKeyHelper === 'string' && json.apiKeyHelper.length > 0
  } catch {
    // no user settings file
  }
  const userEnv = await windowsUserEnv()
  const settingsBaseUrl =
    typeof fileEnv.ANTHROPIC_BASE_URL === 'string' && fileEnv.ANTHROPIC_BASE_URL
      ? fileEnv.ANTHROPIC_BASE_URL
      : undefined
  const processEnvBaseUrl = process.env.ANTHROPIC_BASE_URL || undefined
  const credentialVars = [
    ...new Set([
      ...CREDENTIAL_VARS.filter((n) => typeof fileEnv[n] === 'string' && fileEnv[n]).map((n) => `${n} (settings.json)`),
      ...userEnv.credentials.map((n) => `${n} (variável do usuário)`),
      ...CREDENTIAL_VARS.filter((n) => n !== 'ANTHROPIC_API_KEY' && process.env[n]).map(
        (n) => `${n} (ambiente do Hangar)`
      )
    ])
  ]
  // A variable in the launch environment wins over ~/.claude/settings.json for ANTHROPIC_BASE_URL (the CLI logs
  // "Ignoring ANTHROPIC_BASE_URL from userSettings: the environment this session was launched with already sets it").
  const effective = processEnvBaseUrl ?? settingsBaseUrl
  const source: GatewayInfo['source'] = processEnvBaseUrl
    ? userEnv.baseUrl === processEnvBaseUrl
      ? 'userEnv'
      : 'processEnv'
    : settingsBaseUrl
      ? 'settings'
      : undefined
  return {
    baseUrl: effective ? displayUrl(effective) : undefined,
    source,
    settingsBaseUrl: settingsBaseUrl ? displayUrl(settingsBaseUrl) : undefined,
    userEnvBaseUrl: userEnv.baseUrl ? displayUrl(userEnv.baseUrl) : undefined,
    processEnvBaseUrl: processEnvBaseUrl ? displayUrl(processEnvBaseUrl) : undefined,
    credentialVars,
    apiKeyHelper,
    isGateway: !!effective && !isAnthropicApi(effective)
  }
}

function gatewayItem(g: GatewayInfo, profile: ProviderProfile): DiagnosticItem {
  const title = 'Gateway / endpoint'
  const creds = g.credentialVars.length
    ? `Credenciais configuradas: ${g.credentialVars.join(', ')}.`
    : 'Nenhuma credencial de gateway configurada.'
  const helper = g.apiKeyHelper ? ' Há um apiKeyHelper no settings.json.' : ''
  if (!g.baseUrl) {
    return {
      id: 'gateway',
      title,
      status: 'ok',
      message: 'Nenhum gateway configurado: o Claude Code fala direto com a Anthropic.',
      detail: creds + helper
    }
  }
  if (!g.isGateway) {
    return {
      id: 'gateway',
      title,
      status: 'ok',
      message: `ANTHROPIC_BASE_URL aponta para a própria Anthropic (${g.baseUrl}).`,
      detail: creds + helper
    }
  }
  if (profile.id !== SUBSCRIPTION_PROFILE_ID && profile.kind === 'subscription') {
    return {
      id: 'gateway',
      title,
      status: 'ok',
      message:
        `O Claude Code tem um gateway configurado (${g.baseUrl}), mas o provedor padrão do Hangar, “${profile.name}”, não passa por ele. ` +
        'O claude no terminal continua usando o gateway.',
      detail: creds + helper
    }
  }
  const where =
    g.source === 'settings'
      ? 'no ~/.claude/settings.json'
      : g.source === 'userEnv'
        ? 'nas variáveis de ambiente do Windows'
        : 'no ambiente em que o Hangar foi aberto'
  return {
    id: 'gateway',
    title,
    status: 'warn',
    message:
      `O Claude Code está configurado ${where} para passar por um gateway: ${g.baseUrl}. ` +
      'Com o login da assinatura, todas as requisições vão para esse endereço; se ele estiver fora do ar ou não repassar o login, as sessões falham.',
    detail: creds + helper
  }
}

// ---- Report ----

function providerById(id: string): ProviderProfile | undefined {
  return listProviders().find((p) => p.id === id)
}

/** The launch a "direct" subscription profile would get, built in memory without saving anything. */
function directEnv(): { env: NodeJS.ProcessEnv; settingsEnv: Record<string, string> } {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: ANTHROPIC_API }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const settingsEnv: Record<string, string> = { ANTHROPIC_BASE_URL: ANTHROPIC_API }
  try {
    const fileEnv =
      (JSON.parse(readFileSync(claudeSettingsFile(), 'utf8')) as { env?: Record<string, unknown> }).env ?? {}
    for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (name in fileEnv) settingsEnv[name] = ''
  } catch {
    // no user settings file
  }
  return { env, settingsEnv }
}

export async function diagnose(opts: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const items: DiagnosticItem[] = []
  const [claude, gateway, git] = await Promise.all([
    opts.quick ? Promise.resolve(undefined) : checkClaude(),
    gatewayInfo(),
    opts.quick ? Promise.resolve(undefined) : run('git', ['--version'], process.env, 15_000)
  ])
  if (claude) {
    items.push(claude.item)
    items.push(await checkLogin(claude.exe))
  }

  // Provider profile: the session's, or the default.
  const providerId = opts.providerId ?? settings().get().defaultProviderId ?? SUBSCRIPTION_PROFILE_ID
  const profile = providerById(providerId) ?? providerById(SUBSCRIPTION_PROFILE_ID)!
  items.push(gatewayItem(gateway, profile))
  const test = await testProvider(profile.id)
  items.push({
    id: 'provider',
    title: `Provedor: ${profile.name}`,
    status: test.ok ? 'ok' : 'error',
    message: test.ok
      ? `Respondeu em ${(test.latencyMs / 1000).toFixed(1)} s (modelo ${test.model}).`
      : `O teste de conexão falhou: ${test.error ?? 'erro desconhecido'}`,
    action: test.ok ? undefined : { kind: 'openProviders', label: 'Abrir Provedores' }
  })

  // The built-in subscription profile follows ~/.claude/settings.json; when it fails behind a gateway,
  // test the same login directly against Anthropic to tell whether the gateway is the culprit.
  let fixAvailable = false
  if (!test.ok && gateway.isGateway && profile.id === SUBSCRIPTION_PROFILE_ID) {
    const { env, settingsEnv } = directEnv()
    const direct = await probe(env, settingsEnv)
    fixAvailable = direct.ok
    items.push(
      direct.ok
        ? {
            id: 'direct',
            title: 'Assinatura direto na Anthropic',
            status: 'ok',
            message:
              `Direto em ${ANTHROPIC_API} o mesmo login funciona (${(direct.latencyMs / 1000).toFixed(1)} s). ` +
              `O gateway ${gateway.baseUrl} está quebrando a assinatura. A correção cria o perfil “${DIRECT_PROFILE_NAME}” e o define como padrão, ` +
              'sem mexer no seu ~/.claude/settings.json.',
            action: { kind: 'applyDirectFix', label: 'Corrigir: usar a assinatura direta' }
          }
        : {
            id: 'direct',
            title: 'Assinatura direto na Anthropic',
            status: 'error',
            message: `Direto na Anthropic também falhou (${direct.error}). O problema não é só o gateway: confira o login do Claude Code.`
          }
    )
  }

  if (git) {
    items.push(
      git.ok
        ? { id: 'git', title: 'Git', status: 'ok', message: `Encontrado: ${git.stdout.trim()}.` }
        : {
            id: 'git',
            title: 'Git',
            status: 'warn',
            message: 'O git não foi encontrado no PATH. Worktrees, alterações e o Harness Lab dependem dele.',
            action: { kind: 'openUrl', label: 'Baixar o Git', url: 'https://git-scm.com/download/win' }
          }
    )
  }

  return { items, gateway, fixAvailable, providerName: profile.name, ranAt: Date.now() }
}

/** Creates (or reuses) the "Assinatura (direto)" profile, makes it the default and tests it. */
export async function applyDirectFix(): Promise<DirectFixResult> {
  try {
    const existing = listProviders().find(
      (p) => p.kind === 'subscription' && p.id !== SUBSCRIPTION_PROFILE_ID && (!p.baseUrl || isAnthropicApi(p.baseUrl))
    )
    const profile =
      existing ?? saveProvider({ name: DIRECT_PROFILE_NAME, kind: 'subscription', baseUrl: ANTHROPIC_API })
    setDefaultProvider(profile.id)
    const test = await testProvider(profile.id)
    return {
      ok: true,
      profileId: profile.id,
      profileName: profile.name,
      reused: !!existing,
      testOk: test.ok,
      message: test.ok
        ? `“${profile.name}” agora é o provedor padrão e respondeu em ${(test.latencyMs / 1000).toFixed(1)} s.`
        : `“${profile.name}” agora é o provedor padrão, mas o teste falhou: ${test.error ?? 'erro desconhecido'}`
    }
  } catch (err) {
    return { ok: false, message: maskSecrets(err instanceof Error ? err.message : String(err)) }
  }
}
