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
//   GET  /api/app/models                            synced token models (docs/platform/app-api-models.md)
//   POST /api/app/devices/:id/llm-key               generates or rotates the device's `ahl_…` key
//   *    /api/app/llm/:connection/…                 LLM proxy: checks the device key, the connection's sync and
//                                                   the visible models, then forwards to `upstream` (e.g.
//                                                   tests/mock-anthropic) with the connection's own credential,
//                                                   streaming the answer through
//   GET  /api/me/workspace, /api/decisions,         member routes the app token may read (docs/platform/
//        /api/org-chart?mine=1, /api/inbox          m1-contract.md); org-chart without mine=1 refuses it
//   GET  /api/app/events                            SSE: `id:` increasing, replay after Last-Event-ID, keepalive
//                                                   comments; addDecision()/emitEvent() publish
//
// Like the real platform, the heartbeat answers `revoked` for the access token of an ended grant, and a device
// revoked by the admin cannot register again. No dependencies beyond Node.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mockChart, mockDecisions, mockWorkspace } from './workspace.ts'

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

export interface MockModel {
  model_id: string
  name: string
  context_length?: number
  caps?: string[]
  price_in_per_mtok?: number
  price_out_per_mtok?: number
  kind?: 'text' | 'embedding'
}

/** An LLM connection of the fake platform; only `sync: true` ones reach the app. */
export interface MockConnection {
  id: number
  name: string
  provider: string
  protocol: 'anthropic' | 'openai'
  sync: boolean
  hidden: string[]
  models: MockModel[]
}

export interface MockLlmKey {
  key: string
  deviceId: string
  userId: number
  createdAt: number
}

/** A request that went through the LLM proxy. */
export interface MockProxied {
  connectionId: number
  method: string
  path: string
  model?: string
  deviceId: string
  /** Status the proxy answered (its own refusal or the upstream's). */
  status: number
}

/** One event of GET /api/app/events. */
export interface MockEvent {
  id: number
  type: string
  data: Record<string, unknown>
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
  /** LLM connections (edit freely: `sync`, `hidden`, `models`); the console's "Sincronizar com o Hangar desktop". */
  connections: MockConnection[]
  setSync(connectionId: number, sync: boolean): void
  /** Device LLM keys in force (one per device; rotating replaces it). */
  llmKeys: Map<string, MockLlmKey>
  /** Invalidates every device LLM key (the proxy answers 401 until the app rotates it). */
  invalidateLlmKeys(): void
  proxied: MockProxied[]
  /** The member's data (edit freely): GET /api/me/workspace, /api/decisions, /api/org-chart?mine=1. */
  workspace: Record<string, unknown>
  decisions: Record<string, unknown>[]
  chart: { nodes: Record<string, unknown>[]; agents?: unknown[]; me?: unknown }
  /** Unread items of the inbox (GET /api/inbox → counts.unread). */
  inboxUnread: number
  /** Events published so far (GET /api/app/events replays those after Last-Event-ID). */
  events: MockEvent[]
  /** Publishes an event to every open stream. */
  emitEvent(type: string, data: Record<string, unknown>): MockEvent
  /** A new open decision for the person: decision.created + inbox.changed. */
  addDecision(d: { id: number; title: string; agent?: string; kind?: string }): void
  /** Open event streams right now. */
  streams(): number
  /** Closes every open event stream (the app should reconnect with Last-Event-ID). */
  dropStreams(): void
  /** false: GET /api/app/events answers 404 (an older platform: the app polls). */
  setEventsEnabled(on: boolean): void
  /** Last-Event-ID of every stream opened so far ('' when none was sent). */
  eventResumes: string[]
  count(path: string, grantType?: string): number
  close(): Promise<void>
}

export interface MockPlatformOptions {
  port?: number
  /** Access token lifetime in seconds (default 3600). */
  accessTtlS?: number
  /** Delay before /oauth/token answers, to make concurrent refreshes overlap. */
  tokenDelayMs?: number
  /** Where the LLM proxy forwards (an Anthropic Messages API) and the credential it injects. */
  upstream?: { url: string; token: string }
  /** Initial connections (default: MOCK_CONNECTIONS, not synced). */
  connections?: MockConnection[]
  /** Keepalive comment interval of the event stream (default 25 s, like the platform). */
  keepaliveMs?: number
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

/** Default connections: an Anthropic one (two text models and an embedding) and an OpenAI one (cannot sync). */
export function mockConnections(): MockConnection[] {
  return [
    {
      id: 11,
      name: 'Anthropic Acme',
      provider: 'anthropic',
      protocol: 'anthropic',
      sync: false,
      hidden: [],
      models: [
        {
          model_id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          context_length: 200_000,
          caps: ['tools', 'vision'],
          price_in_per_mtok: 3,
          price_out_per_mtok: 15
        },
        {
          model_id: 'claude-haiku-4-5',
          name: 'Claude Haiku 4.5',
          context_length: 200_000,
          caps: ['tools'],
          price_in_per_mtok: 1,
          price_out_per_mtok: 5
        },
        { model_id: 'voyage-3', name: 'Voyage 3', kind: 'embedding' }
      ]
    },
    {
      id: 12,
      name: 'OpenAI Acme',
      provider: 'openai',
      protocol: 'openai',
      sync: false,
      hidden: [],
      models: [{ model_id: 'gpt-4o', name: 'GPT-4o', context_length: 128_000 }]
    }
  ]
}

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
  const connections = opts.connections ?? mockConnections()
  const llmKeys = new Map<string, MockLlmKey>()
  const proxied: MockProxied[] = []
  const events: MockEvent[] = []
  const eventResumes: string[] = []
  const openStreams = new Set<ServerResponse>()
  let eventsOn = true
  const member: Pick<MockPlatform, 'workspace' | 'decisions' | 'chart' | 'inboxUnread'> = {
    workspace: mockWorkspace(),
    decisions: mockDecisions(),
    chart: mockChart(),
    inboxUnread: 2
  }
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

  const sse = (e: MockEvent) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`
  const emitEvent = (type: string, data: Record<string, unknown>): MockEvent => {
    const e = { id: (events.at(-1)?.id ?? 0) + 1, type, data }
    events.push(e)
    for (const r of openStreams) r.write(sse(e))
    opts.log?.(`event ${e.id} ${type}`)
    return e
  }

  const syncable = (c: MockConnection) => c.sync && c.protocol === 'anthropic'
  const visible = (c: MockConnection) =>
    c.models.filter((m) => (m.kind ?? 'text') === 'text' && !c.hidden.includes(m.model_id))
  const anthropicError = (res: ServerResponse, status: number, type: string, message: string) =>
    json(res, status, { type: 'error', error: { type, message } })

  /** The LLM proxy: device key → connection → visible model → upstream, the answer streamed back as it comes. */
  const proxy = async (
    req: IncomingMessage,
    res: ServerResponse,
    connectionId: number,
    sub: string,
    search: string
  ) => {
    const presented = bearer(req) || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '')
    const owner = llmKeys.get(presented)
    const device = owner && devices.get(owner.deviceId)
    const record = (status: number, model?: string) =>
      proxied.push({
        connectionId,
        method: req.method ?? '',
        path: sub,
        model,
        deviceId: owner?.deviceId ?? '',
        status
      })
    if (!owner || device?.status !== 'active') {
      record(401)
      return anthropicError(res, 401, 'authentication_error', 'chave do dispositivo inválida ou revogada')
    }
    const c = connections.find((x) => x.id === connectionId)
    if (!c || !syncable(c)) {
      record(403)
      return anthropicError(res, 403, 'permission_error', 'esta conexão não está sincronizada com o Hangar desktop')
    }
    if (req.method === 'GET' && sub === '/v1/models') {
      record(200)
      const data = visible(c).map((m) => ({
        type: 'model',
        id: m.model_id,
        display_name: m.name,
        created_at: '2025-01-01T00:00:00Z'
      }))
      return json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
    }
    const raw = req.method === 'POST' ? await readBody(req) : ''
    let model: string | undefined
    if (sub.startsWith('/v1/messages')) {
      try {
        model = (JSON.parse(raw) as { model?: string }).model
      } catch {
        model = undefined
      }
      if (!model || !visible(c).some((m) => m.model_id === model)) {
        record(400, model)
        return anthropicError(
          res,
          400,
          'invalid_request_error',
          `modelo fora da lista desta conexão: ${visible(c)
            .map((m) => m.model_id)
            .join(', ')}`
        )
      }
    }
    if (!opts.upstream) {
      record(502, model)
      return anthropicError(res, 502, 'api_error', 'proxy sem upstream')
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.upstream.token}`
    }
    for (const h of ['anthropic-version', 'anthropic-beta']) {
      const v = req.headers[h]
      if (typeof v === 'string') headers[h] = v
    }
    const up = await fetch(`${opts.upstream.url}${sub}${search}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? raw : undefined
    })
    record(up.status, model)
    res.writeHead(up.status, {
      'content-type': up.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache'
    })
    if (up.body) for await (const chunk of up.body) res.write(chunk)
    res.end()
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

    if (req.method === 'GET' && path === '/api/app/models') {
      if (!appGrant(req, res)) return
      return json(res, 200, {
        version: JSON.stringify(connections.map((c) => [c.id, c.sync, c.hidden, c.models.length])),
        connections: connections.filter(syncable).map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          base_path: `/api/app/llm/${c.id}`,
          models: visible(c).map(({ kind: _kind, ...m }) => m)
        }))
      })
    }

    const llmKey = /^\/api\/app\/devices\/([^/]+)\/llm-key$/.exec(path)
    if (req.method === 'POST' && llmKey) {
      const g = appGrant(req, res)
      if (!g) return
      const id = decodeURIComponent(llmKey[1])
      const d = devices.get(id)
      if (!d || d.userId !== g.userId) return json(res, 404, { detail: 'dispositivo não registrado' })
      if (d.status !== 'active') return json(res, 403, { detail: 'dispositivo revogado' })
      for (const [k, v] of llmKeys) if (v.deviceId === id) llmKeys.delete(k)
      const key = token('ahl_')
      llmKeys.set(key, { key, deviceId: id, userId: g.userId, createdAt: Date.now() })
      return json(res, 200, { key, prefix: key.slice(0, 8), created_at: new Date().toISOString() })
    }

    const llm = /^\/api\/app\/llm\/(\d+)(\/.*)$/.exec(path)
    if (llm) return proxy(req, res, Number(llm[1]), llm[2], url.search)

    if (req.method === 'GET' && path === '/api/me/workspace') {
      if (!appGrant(req, res)) return
      return json(res, 200, member.workspace)
    }

    if (req.method === 'GET' && path === '/api/decisions') {
      if (!appGrant(req, res)) return
      return json(res, 200, member.decisions)
    }

    if (req.method === 'GET' && path === '/api/org-chart') {
      if (!appGrant(req, res)) return
      // The app token reads only the person's own chart.
      if (!['1', 'true'].includes(url.searchParams.get('mine') ?? ''))
        return json(res, 403, { detail: 'o token do app só lê o organograma com mine=1' })
      return json(res, 200, member.chart)
    }

    if (req.method === 'GET' && path === '/api/inbox') {
      if (!appGrant(req, res)) return
      const open = member.decisions.filter((d) => d.kind !== 'notice').length
      return json(res, 200, {
        view: url.searchParams.get('view') ?? 'all',
        counts: { all: member.inboxUnread + 3, unread: member.inboxUnread, decisions: open, blocked: 0 },
        items: []
      })
    }

    if (req.method === 'GET' && path === '/api/app/events') {
      if (!appGrant(req, res)) return
      if (!eventsOn) return json(res, 404, { detail: 'Not Found' })
      const last = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : ''
      eventResumes.push(last)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': conectado\n\n')
      for (const e of events) if (e.id > Number(last || 0)) res.write(sse(e))
      openStreams.add(res)
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), opts.keepaliveMs ?? 25_000)
      req.on('close', () => {
        clearInterval(keepalive)
        openStreams.delete(res)
      })
      return
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
    connections,
    setSync(connectionId, sync) {
      const c = connections.find((x) => x.id === connectionId)
      if (!c) throw new Error(`unknown connection ${connectionId}`)
      c.sync = sync
    },
    llmKeys,
    invalidateLlmKeys() {
      llmKeys.clear()
    },
    proxied,
    get workspace() {
      return member.workspace
    },
    set workspace(v) {
      member.workspace = v
    },
    get decisions() {
      return member.decisions
    },
    set decisions(v) {
      member.decisions = v
    },
    get chart() {
      return member.chart
    },
    set chart(v) {
      member.chart = v
    },
    get inboxUnread() {
      return member.inboxUnread
    },
    set inboxUnread(v) {
      member.inboxUnread = v
    },
    events,
    emitEvent,
    addDecision(d) {
      member.decisions.unshift({
        id: d.id,
        kind: d.kind ?? 'approval',
        employee: 'analista-dados',
        employee_name: d.agent ?? 'Analista de Dados',
        employee_title: 'Analista de BI',
        task: null,
        question: d.title,
        status: 'open',
        created_at: new Date().toISOString(),
        mine: true
      })
      member.inboxUnread++
      // Like the platform, `agent` is the agent's slug.
      emitEvent('decision.created', { id: d.id, title: d.title, agent: 'analista-dados' })
      emitEvent('inbox.changed', { unread: member.inboxUnread })
    },
    streams: () => openStreams.size,
    dropStreams() {
      for (const r of openStreams) r.destroy()
      openStreams.clear()
    },
    setEventsEnabled(on) {
      eventsOn = on
    },
    eventResumes,
    count: (path, grantType) =>
      requests.filter((r) => r.path === path && (grantType === undefined || r.grantType === grantType)).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
