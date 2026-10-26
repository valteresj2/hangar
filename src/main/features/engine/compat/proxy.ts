// Local compat proxy: Claude Code → http://127.0.0.1:<port>/r/<route>/… → the profile's gateway.
//
// Each route is registered by the engine for one upstream base URL (from the provider profile, never from the
// request, so the proxy cannot be pointed elsewhere) under an unguessable id. Requests to /v1/messages and
// /v1/messages/count_tokens whose model needs adapting (shared/compat.ts) go through adaptRequest, and their replies
// through the tool-call repair; everything else, and every Claude model, is piped through untouched. The client's
// credentials pass through as sent; the proxy never logs headers or bodies.
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { modelTraits, type ModelTraits } from '../../../../shared/compat'
import type { ProviderCompat } from '../../../../shared/providers'
import {
  adaptRequest,
  emptyStats,
  isFieldRejection,
  repairMessage,
  SseRewriter,
  type CompatStats,
  type ToolSpec
} from './transform'

interface Route {
  id: string
  upstream: URL
  compat?: ProviderCompat
  stats: CompatStats
  /** Shared routes are reused by every launch of the same profile configuration. */
  key?: string
  /**
   * Models the auto mode sends unchanged (Claude ids) whose gateway rejected an Anthropic-only field: from then on
   * they are adapted too (e.g. a Claude model that LiteLLM reaches through OpenRouter, which refuses `thinking`).
   */
  learned: Set<string>
}

let server: Server | undefined
let port = 0
const routes = new Map<string, Route>()
const sharedRoutes = new Map<string, string>()

/** Starts the proxy on a free loopback port (idempotent). */
export async function startCompatProxy(): Promise<number> {
  if (server) return port
  const s = createServer((req, res) => void serve(req, res))
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => resolve())
  })
  // Streams of a long turn can stay open for many minutes.
  s.requestTimeout = 0
  s.headersTimeout = 60_000
  server = s
  port = (s.address() as AddressInfo).port
  return port
}

export function compatProxyRunning(): boolean {
  return !!server
}

export async function stopCompatProxy(): Promise<void> {
  const s = server
  server = undefined
  routes.clear()
  sharedRoutes.clear()
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}

export interface CompatRoute {
  id: string
  /** Base URL to give Claude Code as ANTHROPIC_BASE_URL. */
  url: string
}

/**
 * Registers `upstream` (a gateway base URL). `shared` routes are keyed by upstream and compat settings, so session
 * restarts reuse them; an own route (the model bench) has its own statistics and is released by its owner.
 */
export function registerRoute(upstream: string, compat: ProviderCompat | undefined, shared = true): CompatRoute {
  if (!server) throw new Error('compat proxy not running')
  const key = `${upstream}\u0000${JSON.stringify(compat ?? {})}`
  const existing = shared ? sharedRoutes.get(key) : undefined
  const id = existing ?? randomBytes(18).toString('base64url')
  if (!existing) {
    routes.set(id, {
      id,
      upstream: new URL(upstream.replace(/\/+$/, '') + '/'),
      compat,
      stats: emptyStats(),
      key: shared ? key : undefined,
      learned: new Set()
    })
    if (shared) sharedRoutes.set(key, id)
  }
  return { id, url: `http://127.0.0.1:${port}/r/${id}` }
}

export function releaseRoute(id: string): void {
  const r = routes.get(id)
  if (!r) return
  routes.delete(id)
  if (r.key) sharedRoutes.delete(r.key)
}

export function routeStats(id: string): CompatStats | undefined {
  const r = routes.get(id)
  return r ? structuredClone(r.stats) : undefined
}

// ---- Serving ----

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length'
])

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: status === 404 ? 'not_found_error' : 'api_error', message } }))
}

interface Upstream {
  status: number
  headers: IncomingMessage['headers']
  stream: IncomingMessage
}

function send(
  target: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: Buffer | undefined,
  client: IncomingMessage,
  res: ServerResponse
): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest
    const up = request(
      target,
      { method, headers: body ? { ...headers, 'content-length': String(body.length) } : headers },
      (r) => resolve({ status: r.statusCode ?? 502, headers: r.headers, stream: r })
    )
    up.on('error', reject)
    // The client went away before the reply ended (interrupted turn): stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy()
    })
    if (body) up.end(body)
    else client.pipe(up)
  })
}

function outHeaders(headers: IncomingMessage['headers'], drop: string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || drop.includes(k)) continue
    out[k] = v
  }
  return out
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = /^\/r\/([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '')
  const route = match ? routes.get(match[1]) : undefined
  if (!match || !route) return fail(res, 404, 'Unknown Hangar compat route.')
  const path = (match[2] ?? '/').replace(/^\/+/, '')
  const target = new URL(path + (match[3] ?? ''), route.upstream)
  route.stats.requests++

  try {
    const isMessages = req.method === 'POST' && /^v1\/messages(\/count_tokens)?$/.test(path)
    if (!isMessages)
      return pipeThrough(
        await send(target, req.method ?? 'GET', outHeaders(req.headers), undefined, req, res),
        res,
        route
      )

    const raw = await readBody(req)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return pipeThrough(await send(target, 'POST', outHeaders(req.headers), raw, req, res), res, route)
    }
    const model = typeof (body as { model?: unknown }).model === 'string' ? (body as { model: string }).model : ''
    let traits = modelTraits(model, route.compat)
    if (model && !traits.adapted && route.learned.has(model)) traits = learnedTraits(traits, body)
    if (!model || !traits.adapted) {
      const up = await send(target, 'POST', outHeaders(req.headers), raw, req, res)
      if (up.status !== 400 || !model) return pipeThrough(up, res, route)
      const text = (await readBody(up.stream)).toString('utf8')
      if (!isFieldRejection(up.status, text)) return replay(res, up, text, route)
      // The gateway refused a field Claude Code only sends to Anthropic: adapt this model from now on.
      route.learned.add(model)
      route.stats.changes.learned = (route.stats.changes.learned ?? 0) + 1
      route.stats.retries++
      traits = learnedTraits(traits, body)
    }

    route.stats.adaptedRequests++
    // Anthropic betas mean nothing to other providers; some gateways reject unknown ones.
    const headers = { ...outHeaders(req.headers, ['anthropic-beta', 'accept-encoding']), 'accept-encoding': 'identity' }
    let adapted = adaptRequest(body, traits)
    let up = await send(target, 'POST', headers, Buffer.from(JSON.stringify(adapted.body)), req, res)
    if (up.status === 400) {
      const text = (await readBody(up.stream)).toString('utf8')
      if (!isFieldRejection(up.status, text)) return replay(res, up, text, route)
      route.stats.retries++
      adapted = adaptRequest(body, traits, { strict: true })
      up = await send(target, 'POST', headers, Buffer.from(JSON.stringify(adapted.body)), req, res)
    }
    for (const c of adapted.changes) route.stats.changes[c] = (route.stats.changes[c] ?? 0) + 1
    if (up.status >= 400) return replay(res, up, (await readBody(up.stream)).toString('utf8'), route)
    if (path.endsWith('count_tokens')) return pipeThrough(up, res, route)
    return rewrite(up, res, adapted.tools, route)
  } catch (err) {
    fail(
      res,
      502,
      `Hangar compat proxy could not reach the gateway: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Adaptation for a model learned to need it: requests are cleaned, but its own output limit is kept. */
function learnedTraits(traits: ModelTraits, body: unknown): ModelTraits {
  const max = (body as { max_tokens?: unknown }).max_tokens
  return {
    ...traits,
    adapted: true,
    reasoning: false,
    maxOutputTokens: Math.max(traits.maxOutputTokens, typeof max === 'number' ? max : 0)
  }
}

function countError(route: Route, status: number): void {
  if (status >= 400) route.stats.upstreamErrors[status] = (route.stats.upstreamErrors[status] ?? 0) + 1
}

function pipeThrough(up: Upstream, res: ServerResponse, route: Route): void {
  countError(route, up.status)
  res.writeHead(up.status, outHeaders(up.headers))
  up.stream.pipe(res)
}

function replay(res: ServerResponse, up: Upstream, text: string, route: Route): void {
  countError(route, up.status)
  res.writeHead(up.status, outHeaders(up.headers, ['content-encoding']))
  res.end(text)
}

function rewrite(up: Upstream, res: ServerResponse, tools: ToolSpec[], route: Route): void {
  const type = String(up.headers['content-type'] ?? '')
  if (type.includes('text/event-stream')) {
    res.writeHead(up.status, outHeaders(up.headers, ['content-encoding']))
    const sse = new SseRewriter(tools, route.stats)
    const decoder = new TextDecoder()
    up.stream.on('data', (c: Buffer) => {
      const out = sse.push(decoder.decode(c, { stream: true }))
      if (out) res.write(out)
    })
    up.stream.on('end', () => res.end(sse.push(decoder.decode()) + sse.end()))
    up.stream.on('error', () => res.destroy())
    return
  }
  if (type.includes('json')) {
    void readBody(up.stream).then((buf) => {
      let text = buf.toString('utf8')
      try {
        text = JSON.stringify(repairMessage(JSON.parse(text), tools, route.stats))
      } catch {
        // Not a message: send as received.
      }
      res.writeHead(up.status, outHeaders(up.headers, ['content-encoding']))
      res.end(text)
    })
    return
  }
  pipeThrough(up, res, route)
}
