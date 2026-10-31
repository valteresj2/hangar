// Agent Hangar tools in every session: while the app is connected, Claude Code gets the platform's MCP server
// (plan, create and ship agents, multi-agents, digital employees, talk to an agent…) through a loopback bridge,
// http://127.0.0.1:<port>/<secret>/mcp, that forwards to <platform>/mcp with the login's own token (scope `mcp`,
// granted with `app` at login). The token never leaves the main process, and refreshes happen here, so a session
// outlives the one-hour access token. Only /mcp of the logged-in platform is reachable; the secret in the path keeps
// other local processes out. The proxy never logs headers or bodies.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { apiClient, currentLogin } from './controller'

/** Name of the server in the sessions (tools show up as mcp__agent-hangar__<tool>). */
export const PLATFORM_MCP_NAME = 'agent-hangar'
/** Planning, building and shipping an agent can take minutes. */
const TOOL_TIMEOUT_MS = 15 * 60_000
const FORWARD_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const FORWARD_RESPONSE = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version', 'www-authenticate']

let server: Server | undefined
let port = 0
const secret = randomBytes(18).toString('base64url')

export async function startMcpBridge(): Promise<void> {
  if (server) return
  const s = createServer((req, res) => void serve(req, res))
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => resolve())
  })
  // MCP streams (SSE) stay open while a tool runs.
  s.requestTimeout = 0
  s.headersTimeout = 60_000
  server = s
  port = (s.address() as AddressInfo).port
}

export async function stopMcpBridge(): Promise<void> {
  const s = server
  server = undefined
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}

/** The server to give a session, or undefined when the app is not connected (or the bridge is not running). */
export function platformMcpServer(): { type: 'http'; url: string; timeout: number } | undefined {
  if (!server || !currentLogin()) return undefined
  return { type: 'http', url: `http://127.0.0.1:${port}/${secret}/mcp`, timeout: TOOL_TIMEOUT_MS }
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.destroy()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const prefix = `/${secret}/mcp`
  const url = req.url ?? ''
  if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`))
    return reply(res, 404, 'not found')
  if (!currentLogin()) return reply(res, 503, 'O Hangar não está conectado à plataforma.')

  const ac = new AbortController()
  res.on('close', () => ac.abort())
  try {
    const headers: Record<string, string> = {}
    for (const name of FORWARD_REQUEST) {
      const v = req.headers[name]
      if (typeof v === 'string') headers[name] = v
    }
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    const upstream = await apiClient.forward(`/mcp${url.slice(prefix.length)}`, {
      method,
      headers,
      body,
      signal: ac.signal
    })
    const out: Record<string, string> = {}
    for (const name of FORWARD_RESPONSE) {
      const v = upstream.headers.get(name)
      if (v) out[name] = v
    }
    res.writeHead(upstream.status, out)
    if (!upstream.body) return void res.end()
    Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>)
      .on('error', () => res.destroy())
      .pipe(res)
  } catch (err) {
    if (ac.signal.aborted) return
    reply(res, 502, err instanceof Error ? err.message : 'Falha ao falar com a plataforma.')
  }
}
