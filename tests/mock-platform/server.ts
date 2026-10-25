// A local fake of the Agent Hangar platform, as far as the app needs it (docs/platform/app-api-phase1.md):
//
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
//   POST /oauth/register                            RFC 7591 (public clients, loopback redirects only)
//   GET  /oauth/authorize                           auto-approves (or denies) and 302s to the loopback callback;
//                                                   loopback redirects match with any port (RFC 8252 §7.3)
//   POST /oauth/token                               authorization_code (+ PKCE S256) and rotating refresh_token
//                                                   with reuse detection (a spent refresh token revokes the grant)
//   POST /oauth/revoke                              RFC 7009
//   GET  /api/app/me, POST /api/app/devices, POST /api/app/devices/:id/heartbeat
//
// Like the real platform, the heartbeat answers `revoked` for the access token of an ended grant, and a device
// revoked by the admin cannot register again. No dependencies beyond Node.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockGrant {
  id: number
  clientId: string
  userId: number
  scope: string
  access: string
  refresh: string
  previousRefresh?: string
  accessExpiresAt: number
  revoked: boolean
}

export interface MockDevice {
  deviceId: string
  userId: number
  grantId: number
  name: string
  os: string
  osVersion: string
  appVersion: string
  channel: string
  status: 'active' | 'revoked'
  revokedBy?: 'admin' | 'system'
  heartbeats: number
}

export interface MockClient {
  id: string
  redirectUris: string[]
  scope: string
  softwareId?: string
  softwareVersion?: string
}

export interface MockRequest {
  method: string
  path: string
  /** grant_type for /oauth/token. */
  grantType?: string
  status: number
}

export interface MockPlatform {
  url: string
  port: number
  clients: Map<string, MockClient>
  grants: MockGrant[]
  devices: Map<string, MockDevice>
  requests: MockRequest[]
  /** Admin: revokes the device and its grant (POST /api/app/admin/devices/{id}/revoke). */
  revokeDevice(deviceId: string): void
  /** Makes every access token expire now (the next call gets a 401 and the app refreshes). */
  expireAccessTokens(): void
  /** What /oauth/authorize does: approve (default) or answer access_denied. */
  setConsent(answer: 'approve' | 'deny'): void
  count(path: string, grantType?: string): number
  close(): Promise<void>
}

export interface MockPlatformOptions {
  port?: number
  /** Access token lifetime in seconds (default 3600). */
  accessTtlS?: number
  /** Delay before /oauth/token answers, to make concurrent refreshes overlap. */
  tokenDelayMs?: number
  log?: (line: string) => void
}

export const MOCK_USER = {
  id: 7,
  email: 'ana.souza@acme.example',
  name: 'Ana Souza',
  avatar_url: null,
  org_role: 'member',
  teams: [
    { id: 3, slug: 'dados', name: 'Dados' },
    { id: 5, slug: 'plataforma', name: 'Plataforma' }
  ]
}
export const MOCK_ORG = { id: 1, name: 'Acme Ltda', slug: 'acme', brand: {} }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const token = (prefix: string) => prefix + randomBytes(24).toString('base64url')
const s256 = (v: string) => createHash('sha256').update(v, 'ascii').digest('base64url')

function redirectMatches(asked: string, registered: string): boolean {
  if (asked === registered) return true
  try {
    const a = new URL(asked)
    const r = new URL(registered)
    return (
      LOOPBACK.has(r.hostname) &&
      a.hostname === r.hostname &&
      a.protocol === r.protocol &&
      a.pathname === r.pathname &&
      a.search === r.search &&
      !a.username &&
      !a.hash
    )
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startMockPlatform(opts: MockPlatformOptions = {}): Promise<MockPlatform> {
  const clients = new Map<string, MockClient>()
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string; used: boolean }
  >()
  const grants: MockGrant[] = []
  const devices = new Map<string, MockDevice>()
  const requests: MockRequest[] = []
  let consent: 'approve' | 'deny' = 'approve'
  let base = ''
  const ttl = (opts.accessTtlS ?? 3600) * 1000

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const oauthError = (res: ServerResponse, status: number, error: string, description: string) =>
    json(res, status, { error, error_description: description })

  const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
  /** The grant of a valid app token, or a 401 already sent. */
  const appGrant = (req: IncomingMessage, res: ServerResponse): MockGrant | undefined => {
    const t = bearer(req)
    const g = grants.find((x) => x.access === t)
    if (!g || g.revoked || g.accessExpiresAt < Date.now()) {
      json(res, 401, { detail: 'token inválido ou expirado' })
      return undefined
    }
    if (!g.scope.split(' ').includes('app')) {
      json(res, 403, { detail: 'token sem o escopo app' })
      return undefined
    }
    return g
  }

  const issue = (g: MockGrant) => {
    if (g.refresh) g.previousRefresh = g.refresh
    g.access = token('aho_')
    g.refresh = token('ahr_')
    g.accessExpiresAt = Date.now() + ttl
    return {
      access_token: g.access,
      token_type: 'Bearer',
      expires_in: ttl / 1000,
      refresh_token: g.refresh,
      scope: g.scope
    }
  }

  const routes = async (req: IncomingMessage, res: ServerResponse, rec: MockRequest): Promise<void> => {
    const url = new URL(req.url ?? '/', base)
    const path = url.pathname

    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['app', 'mcp'],
        token_endpoint_auth_methods_supported: ['none']
      })

    if (req.method === 'POST' && path === '/oauth/register') {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>
      } catch {
        return oauthError(res, 400, 'invalid_client_metadata', 'corpo JSON esperado')
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : []
      if (!uris.length || !uris.every((u) => LOOPBACK.has(new URL(u).hostname)))
        return oauthError(res, 400, 'invalid_redirect_uri', 'redirect não permitido')
      if ((body.token_endpoint_auth_method ?? 'none') !== 'none')
        return oauthError(res, 400, 'invalid_client_metadata', 'só clientes públicos')
      const client: MockClient = {
        id: token('mcp_'),
        redirectUris: uris,
        scope: typeof body.scope === 'string' ? body.scope : 'mcp',
        softwareId: typeof body.software_id === 'string' ? body.software_id : undefined,
        softwareVersion: typeof body.software_version === 'string' ? body.software_version : undefined
      }
      clients.set(client.id, client)
      return json(res, 201, { client_id: client.id, redirect_uris: uris, scope: client.scope })
    }

    if (req.method === 'GET' && path === '/oauth/authorize') {
      const q = url.searchParams
      const client = clients.get(q.get('client_id') ?? '')
      const redirect = q.get('redirect_uri') ?? ''
      if (!client || !client.redirectUris.some((r) => redirectMatches(redirect, r))) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end('<h2>Não foi possível conectar o app</h2>')
      }
      const back = (params: Record<string, string>) => {
        const to = new URL(redirect)
        for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v)
        res.writeHead(302, { location: to.href })
        res.end()
      }
      const state = q.get('state') ?? ''
      const challenge = q.get('code_challenge') ?? ''
      if (
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !/^[\w-]{43,128}$/.test(challenge)
      )
        return back({ error: 'invalid_request', error_description: 'PKCE obrigatório', state })
      const scope = q.get('scope') || 'mcp'
      if (!scope.split(' ').every((s) => client.scope.split(' ').includes(s)))
        return back({ error: 'invalid_scope', error_description: 'escopo não registrado', state })
      if (consent === 'deny') return back({ error: 'access_denied', state, iss: base })
      const code = token('code_')
      codes.set(code, { clientId: client.id, redirectUri: redirect, challenge, scope, used: false })
      return back({ code, state, iss: base })
    }

    if (req.method === 'POST' && path === '/oauth/token') {
      const form = new URLSearchParams(await readBody(req))
      rec.grantType = form.get('grant_type') ?? ''
      if (opts.tokenDelayMs) await new Promise((r) => setTimeout(r, opts.tokenDelayMs))
      if (rec.grantType === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '')
        if (!c || c.used) return oauthError(res, 400, 'invalid_grant', 'código inválido ou já usado')
        if (c.clientId !== form.get('client_id') || c.redirectUri !== form.get('redirect_uri'))
          return oauthError(res, 400, 'invalid_grant', 'o código não é deste app ou deste redirect_uri')
        if (s256(form.get('code_verifier') ?? '') !== c.challenge)
          return oauthError(res, 400, 'invalid_grant', 'verificação PKCE falhou')
        c.used = true
        const g: MockGrant = {
          id: grants.length + 1,
          clientId: c.clientId,
          userId: MOCK_USER.id,
          scope: c.scope,
          access: '',
          refresh: '',
          accessExpiresAt: 0,
          revoked: false
        }
        grants.push(g)
        return json(res, 200, issue(g))
      }
      if (rec.grantType === 'refresh_token') {
        const presented = form.get('refresh_token') ?? ''
        const g = grants.find((x) => x.refresh === presented)
        if (!g) {
          const reused = grants.find((x) => x.previousRefresh === presented && !x.revoked)
          if (reused) reused.revoked = true // a spent refresh token came back: it leaked
          return oauthError(res, 400, 'invalid_grant', 'refresh token inválido')
        }
        if (g.revoked)
          return oauthError(res, 400, 'invalid_grant', 'autorização revogada ou expirada — conecte de novo')
        if (form.get('client_id') && form.get('client_id') !== g.clientId)
          return oauthError(res, 400, 'invalid_grant', 'o refresh token não é deste app')
        return json(res, 200, issue(g))
      }
      return oauthError(res, 400, 'unsupported_grant_type', 'use authorization_code ou refresh_token')
    }

    if (req.method === 'POST' && path === '/oauth/revoke') {
      const t = new URLSearchParams(await readBody(req)).get('token') ?? ''
      const g = grants.find((x) => x.access === t || x.refresh === t)
      if (g) g.revoked = true
      return json(res, 200, {})
    }

    if (req.method === 'GET' && path === '/api/app/me') {
      if (!appGrant(req, res)) return
      return json(res, 200, {
        user: MOCK_USER,
        org: MOCK_ORG,
        platform: { version: 'mock-1.0', features: {} },
        design_tokens: { version: 'mock' }
      })
    }

    if (req.method === 'POST' && path === '/api/app/devices') {
      const g = appGrant(req, res)
      if (!g) return
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, string>
      const id = body.device_id ?? ''
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json(res, 400, { detail: 'device_id inválido' })
      const existing = devices.get(id)
      if (existing?.status === 'revoked' && existing.revokedBy === 'admin')
        return json(res, 403, { detail: 'dispositivo revogado pelo administrador' })
      const d: MockDevice = {
        deviceId: id,
        userId: g.userId,
        grantId: g.id,
        name: body.name ?? '',
        os: body.os ?? '',
        osVersion: body.os_version ?? '',
        appVersion: body.app_version ?? '',
        channel: body.channel ?? '',
        status: 'active',
        heartbeats: existing?.heartbeats ?? 0
      }
      devices.set(id, d)
      return json(res, 200, {
        device: { id: 1, device_id: id, name: d.name, os: d.os, app_version: d.appVersion, status: d.status }
      })
    }

    const hb = /^\/api\/app\/devices\/([^/]+)\/heartbeat$/.exec(path)
    if (req.method === 'POST' && hb) {
      const id = decodeURIComponent(hb[1])
      const t = bearer(req)
      const g = grants.find((x) => x.access === t)
      // The token of an ended grant still gets an answer: `revoked`, so the app logs out.
      if (g?.revoked) {
        const d = devices.get(id)
        if (d && d.status === 'active' && d.grantId === g.id)
          Object.assign(d, { status: 'revoked', revokedBy: 'system' })
        return json(res, 200, { status: 'revoked' })
      }
      if (!appGrant(req, res)) return
      const d = devices.get(id)
      if (!d) return json(res, 404, { detail: 'dispositivo não registrado' })
      d.heartbeats++
      return json(res, 200, { status: d.status })
    }

    json(res, 404, { detail: 'Not Found' })
  }

  const server: Server = createServer((req, res) => {
    const rec: MockRequest = { method: req.method ?? '', path: (req.url ?? '').split('?')[0], status: 0 }
    requests.push(rec)
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status: number, ...rest: unknown[]) => {
      rec.status = status
      opts.log?.(`${rec.method} ${rec.path}${rec.grantType ? ` (${rec.grantType})` : ''} → ${status}`)
      return (writeHead as (s: number, ...r: unknown[]) => ServerResponse)(status, ...rest)
    }
    routes(req, res, rec).catch((err: unknown) => json(res, 500, { detail: String(err) }))
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`

  return {
    url: base,
    port,
    clients,
    grants,
    devices,
    requests,
    revokeDevice(deviceId) {
      const d = devices.get(deviceId)
      if (!d) throw new Error(`unknown device ${deviceId}`)
      d.status = 'revoked'
      d.revokedBy = 'admin'
      const g = grants.find((x) => x.id === d.grantId)
      if (g) g.revoked = true
    },
    expireAccessTokens() {
      for (const g of grants) g.accessExpiresAt = Date.now() - 1
    },
    setConsent(answer) {
      consent = answer
    },
    count: (path, grantType) =>
      requests.filter((r) => r.path === path && (grantType === undefined || r.grantType === grantType)).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
