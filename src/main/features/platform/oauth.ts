// OAuth 2.1 for a native public client (RFC 8252): discovery (RFC 8414), dynamic registration (RFC 7591),
// authorization code + PKCE S256 through an ephemeral loopback server, token exchange, rotating refresh and
// revocation (RFC 7009). No Electron here: the caller injects fetch and the browser opener, so tests can drive it.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PlatformError, hostOf, networkError, sessionExpired } from './errors'
import { challengeS256, createState, createVerifier, sameState } from './pkce'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export const SCOPE = 'app mcp'
export const LOGIN_TIMEOUT_MS = 5 * 60_000
const HTTP_TIMEOUT_MS = 20_000

export interface ServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

/** What the app keeps (encrypted) after a login. */
export interface TokenSet {
  /** Platform base URL the tokens belong to. */
  url: string
  clientId: string
  tokenEndpoint: string
  revocationEndpoint?: string
  accessToken: string
  refreshToken?: string
  /** Epoch ms; 0 when the server did not say. */
  expiresAt: number
  scope?: string
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (err) {
    throw networkError(url, err)
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await res.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** OAuth error bodies: `{error, error_description}`; the platform's descriptions are already in Portuguese. */
function oauthFailure(body: Record<string, unknown> | undefined, status: number, what: string): PlatformError {
  const code = str(body?.error)
  const desc = str(body?.error_description) ?? str(body?.detail)
  if (code === 'invalid_client')
    return new PlatformError('invalid_client', desc ?? 'A plataforma não reconhece mais este app.', status)
  if (code === 'invalid_grant') return new PlatformError('session_expired', desc ?? sessionExpired().message, status)
  return new PlatformError('oauth', `${what}: ${desc ?? code ?? `HTTP ${status}`}`, status)
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** Authorization server metadata. RFC 8414 puts the well-known segment before the base path; try that first. */
export async function discover(base: string, fetchFn: FetchFn): Promise<ServerMetadata> {
  const u = new URL(base)
  const path = u.pathname.replace(/\/+$/, '')
  const candidates = [`${u.origin}/.well-known/oauth-authorization-server${path}`]
  if (path) candidates.push(`${base}/.well-known/oauth-authorization-server`)
  for (const url of candidates) {
    const res = await request(fetchFn, url, { headers: { accept: 'application/json' } })
    if (!res.ok) continue
    const body = await readJson(res)
    if (!body || !isHttpUrl(body.authorization_endpoint) || !isHttpUrl(body.token_endpoint)) continue
    const methods = Array.isArray(body.code_challenge_methods_supported)
      ? body.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string')
      : undefined
    if (methods && !methods.includes('S256'))
      throw new PlatformError('discovery', 'A plataforma não suporta PKCE com S256, exigido pelo Hangar.')
    return {
      issuer: str(body.issuer) ?? base,
      authorization_endpoint: body.authorization_endpoint,
      token_endpoint: body.token_endpoint,
      registration_endpoint: isHttpUrl(body.registration_endpoint) ? body.registration_endpoint : undefined,
      revocation_endpoint: isHttpUrl(body.revocation_endpoint) ? body.revocation_endpoint : undefined,
      code_challenge_methods_supported: methods
    }
  }
  throw new PlatformError(
    'discovery',
    `${hostOf(base)} não parece ser uma plataforma Agent Hangar (sem metadados OAuth). Confira a URL.`
  )
}

/** Dynamic client registration (once per platform; the caller caches the client_id). */
export async function registerClient(meta: ServerMetadata, appVersion: string, fetchFn: FetchFn): Promise<string> {
  if (!meta.registration_endpoint)
    throw new PlatformError('registration', 'A plataforma não aceita registro de apps (registro dinâmico).')
  const res = await request(fetchFn, meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Hangar Desktop',
      software_id: 'hangar-desktop',
      software_version: appVersion,
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE
    })
  })
  const body = await readJson(res)
  const clientId = str(body?.client_id)
  if (!res.ok || !clientId) {
    const desc = str(body?.error_description) ?? str(body?.detail) ?? `HTTP ${res.status}`
    throw new PlatformError('registration', `A plataforma recusou o registro do app: ${desc}`, res.status)
  }
  return clientId
}

export function authorizeUrl(
  meta: ServerMetadata,
  p: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string }
): string {
  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', p.clientId)
  url.searchParams.set('redirect_uri', p.redirectUri)
  url.searchParams.set('state', p.state)
  url.searchParams.set('code_challenge', p.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('resource', p.resource)
  return url.href
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hangar · ${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:72px auto;padding:0 16px;line-height:1.5;color:#1f1e1d;background:#faf9f5">
<h2 style="margin-bottom:8px">${title}</h2><p>${message}</p></body></html>`
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
    'referrer-policy': 'no-referrer'
  })
  res.end(html)
}

export interface LoopbackResult {
  code: string
  iss?: string
}

export interface Loopback {
  redirectUri: string
  /** Resolves with the code of the first callback whose `state` matches; rejects on error/timeout/abort. */
  result: Promise<LoopbackResult>
  close(): void
}

/**
 * Ephemeral HTTP server on 127.0.0.1:<random port>/callback (RFC 8252 §7.3). Callbacks with a wrong `state`
 * get a 400 and are otherwise ignored, so a stray request cannot end (or hijack) the login.
 */
export async function startLoopback(
  state: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Loopback> {
  let settle: { resolve(r: LoopbackResult): void; reject(e: Error): void } | undefined
  const result = new Promise<LoopbackResult>((resolve, reject) => (settle = { resolve, reject }))
  // The flow may be abandoned before anyone awaits result; never surface that as an unhandled rejection.
  result.catch(() => {})

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') return respond(res, 404, page('Não encontrado', ''))
    const q = url.searchParams
    if (!sameState(state, q.get('state')))
      return respond(res, 400, page('Pedido inválido', 'Este link de retorno não corresponde ao login em andamento.'))
    const error = q.get('error')
    if (error) {
      const denied = error === 'access_denied'
      respond(
        res,
        200,
        page(
          denied ? 'Acesso não autorizado' : 'Não foi possível conectar',
          'Volte ao Hangar para tentar de novo. Pode fechar esta aba.'
        )
      )
      finish(
        new PlatformError(
          denied ? 'denied' : 'oauth',
          denied
            ? 'O acesso não foi autorizado na plataforma.'
            : `A plataforma recusou o login: ${q.get('error_description') ?? error}`
        )
      )
      return
    }
    const code = q.get('code')
    if (!code) return respond(res, 400, page('Pedido inválido', 'O retorno da plataforma veio sem código.'))
    respond(res, 200, page('Hangar conectado', 'Pronto! Pode fechar esta aba e voltar ao Hangar.'))
    finish(undefined, { code, iss: q.get('iss') ?? undefined })
  })

  const timer = setTimeout(
    () => finish(new PlatformError('timeout', 'O login não foi concluído em 5 minutos. Tente de novo.')),
    opts.timeoutMs ?? LOGIN_TIMEOUT_MS
  )
  timer.unref()
  const onAbort = () => finish(new PlatformError('canceled', 'Login cancelado.'))
  function finish(err?: Error, value?: LoopbackResult): void {
    if (!settle) return
    const s = settle
    settle = undefined
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    // Let the page reach the browser before dropping connections.
    server.close()
    setTimeout(() => server.closeAllConnections(), 200).unref()
    if (err) s.reject(err)
    else if (value) s.resolve(value)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
  const { port } = server.address() as AddressInfo
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort)

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: () => finish(new PlatformError('canceled', 'Login cancelado.'))
  }
}

function toTokenSet(
  body: Record<string, unknown> | undefined,
  base: Omit<TokenSet, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope'>,
  previousRefresh?: string,
  now = Date.now()
): TokenSet {
  const accessToken = str(body?.access_token)
  if (!accessToken) throw new PlatformError('oauth', 'A plataforma não devolveu um token de acesso.')
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 0
  return {
    ...base,
    accessToken,
    // Rotation: a new refresh token replaces the old one; servers that do not rotate keep the old one valid.
    refreshToken: str(body?.refresh_token) ?? previousRefresh,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
    scope: str(body?.scope)
  }
}

async function postForm(fetchFn: FetchFn, url: string, form: Record<string, string>): Promise<Response> {
  return request(fetchFn, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  })
}

export async function exchangeCode(
  meta: ServerMetadata,
  p: { base: string; clientId: string; code: string; verifier: string; redirectUri: string },
  fetchFn: FetchFn
): Promise<TokenSet> {
  const res = await postForm(fetchFn, meta.token_endpoint, {
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.verifier,
    client_id: p.clientId,
    redirect_uri: p.redirectUri
  })
  const body = await readJson(res)
  if (!res.ok) throw oauthFailure(body, res.status, 'A plataforma recusou o código de login')
  const tokens = toTokenSet(body, {
    url: p.base,
    clientId: p.clientId,
    tokenEndpoint: meta.token_endpoint,
    revocationEndpoint: meta.revocation_endpoint
  })
  if (tokens.scope && !tokens.scope.split(/\s+/).includes('app'))
    throw new PlatformError(
      'oauth',
      'A plataforma não concedeu o acesso do app (escopo "app"). Ela pode estar desatualizada para este app.'
    )
  return tokens
}

/** One refresh_token grant. The caller (TokenManager) makes sure only one runs at a time. */
export async function refreshTokens(tokens: TokenSet, fetchFn: FetchFn): Promise<TokenSet> {
  if (!tokens.refreshToken) throw sessionExpired()
  const res = await postForm(fetchFn, tokens.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId
  })
  const body = await readJson(res)
  if (!res.ok) {
    const err = oauthFailure(body, res.status, 'A plataforma recusou renovar o login')
    // Any refusal of the refresh token itself means the login is gone.
    throw err.code === 'invalid_client' || (res.status >= 400 && res.status < 500) ? sessionExpired() : err
  }
  const { url, clientId, tokenEndpoint, revocationEndpoint } = tokens
  return toTokenSet(body, { url, clientId, tokenEndpoint, revocationEndpoint }, tokens.refreshToken)
}

/** RFC 7009. Best effort: the local logout happens whatever the platform answers. */
export async function revokeTokens(tokens: TokenSet, fetchFn: FetchFn): Promise<void> {
  if (!tokens.revocationEndpoint) return
  // Revoking the refresh token drops the whole grant on the platform; the access token goes with it.
  const token = tokens.refreshToken ?? tokens.accessToken
  await postForm(fetchFn, tokens.revocationEndpoint, {
    token,
    token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token',
    client_id: tokens.clientId
  }).catch(() => undefined)
}

export interface LoginDeps {
  fetch: FetchFn
  openBrowser(url: string): Promise<unknown>
  /** Cached client_id for this platform, if any. */
  cachedClientId?: string
  saveClientId(clientId: string | undefined): void
  appVersion: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** The whole interactive login. Resolves with the tokens; registers the client first when needed. */
export async function login(base: string, deps: LoginDeps): Promise<TokenSet> {
  const meta = await discover(base, deps.fetch)
  let clientId = deps.cachedClientId
  if (!clientId) {
    clientId = await registerClient(meta, deps.appVersion, deps.fetch)
    deps.saveClientId(clientId)
  }
  const state = createState()
  const verifier = createVerifier()
  const loopback = await startLoopback(state, { timeoutMs: deps.timeoutMs, signal: deps.signal })
  try {
    await deps.openBrowser(
      authorizeUrl(meta, {
        clientId,
        redirectUri: loopback.redirectUri,
        state,
        challenge: challengeS256(verifier),
        resource: base
      })
    )
    const { code, iss } = await loopback.result
    // RFC 9207: a callback naming another issuer is a mix-up attack.
    if (iss && meta.issuer && iss.replace(/\/+$/, '') !== meta.issuer.replace(/\/+$/, ''))
      throw new PlatformError('oauth', 'O retorno do login veio de outra plataforma. Tente de novo.')
    try {
      return await exchangeCode(meta, { base, clientId, code, verifier, redirectUri: loopback.redirectUri }, deps.fetch)
    } catch (err) {
      // The platform forgot (or blocked) this client: register again next time.
      if (err instanceof PlatformError && err.code === 'invalid_client') deps.saveClientId(undefined)
      throw err
    }
  } finally {
    loopback.close()
  }
}
