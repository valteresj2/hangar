// A local fake of the Anthropic Messages API, good enough for the Claude Code CLI.
//
//   POST /v1/messages               JSON or SSE stream (message_start, content_block_start/delta/stop for text,
//                                   thinking and tool_use with input_json_delta, message_delta, message_stop)
//   POST /v1/messages/count_tokens  { input_tokens }
//   GET  /v1/models[/:id]           a small model list
//   anything else                   404 with an Anthropic-style error body, recorded in `unknown`
//
// A `delay=<ms>` parameter on the script marker overrides the delay between SSE events for that request.
//
// What the "model" answers comes from scripts.ts. No dependencies beyond Node.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { findScript, runScript, type Block, type MessagesRequest, type ScriptReply } from './scripts.ts'

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  at: number
}

export interface MockAnthropic {
  url: string
  port: number
  /** Every request, in arrival order. */
  requests: RecordedRequest[]
  /** Requests to routes the mock does not implement. */
  unknown: RecordedRequest[]
  /** POST /v1/messages bodies only. */
  messages(): MessagesRequest[]
  reset(): void
  close(): Promise<void>
}

export interface MockOptions {
  /** 0 (default) picks a free port. */
  port?: number
  host?: string
  /** Delay between SSE events, to make streaming observable. Default 12 ms. */
  eventDelayMs?: number
  log?: (line: string) => void
}

export const MOCK_MODELS = [
  { id: 'claude-opus-4-5', display_name: 'Claude Opus (mock)' },
  { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet (mock)' },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku (mock)' }
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock_${Date.now()}` })
  res.end(JSON.stringify(body))
}

function errorBody(type: string, message: string) {
  return { type: 'error', error: { type, message }, request_id: `req_mock_${Date.now()}` }
}

function tokenOf(req: IncomingMessage): string | undefined {
  const key = req.headers['x-api-key']
  if (typeof key === 'string' && key) return key
  const auth = req.headers.authorization
  if (typeof auth === 'string') return auth.replace(/^Bearer\s+/i, '')
  return undefined
}

const estimateTokens = (value: unknown) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4))

function usage(input: number, output: number) {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

/** Splits text into a few chunks (so clients see several deltas). */
function chunks(text: string, size = 18): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length ? out : ['']
}

function finalContent(blocks: Block[]): Record<string, unknown>[] {
  return blocks.map((b) => ({ ...b }))
}

async function streamReply(res: ServerResponse, reply: ScriptReply, model: string, inputTokens: number, delayMs: number): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_mock_${Date.now()}` })
  const send = async (event: string, data: Record<string, unknown>) => {
    if (res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
    if (delayMs) await sleep(delayMs)
  }
  const id = `msg_mock_${Date.now().toString(36)}`
  await send('message_start', {
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage(inputTokens, 1) }
  })
  await send('ping', {})
  let outputTokens = 0
  for (const [index, block] of reply.blocks.entries()) {
    if (block.type === 'text') {
      await send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (const piece of chunks(block.text)) await send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
    } else if (block.type === 'thinking') {
      await send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      for (const piece of chunks(block.thinking, 30)) await send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } })
      await send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } })
    } else {
      await send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '' } })
      for (const piece of chunks(JSON.stringify(block.input), 40)) await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } })
    }
    outputTokens += estimateTokens(block)
    await send('content_block_stop', { index })
  }
  await send('message_delta', { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
  await send('message_stop', {})
  res.end()
}

export async function startMockAnthropic(opts: MockOptions = {}): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = []
  const unknown: RecordedRequest[] = []
  const delayMs = opts.eventDelayMs ?? 12
  const log = opts.log ?? (() => {})

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const raw = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : ''
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    const record: RecordedRequest = { method: req.method ?? 'GET', path, headers: req.headers, body, at: Date.now() }
    requests.push(record)
    log(`${record.method} ${path}`)

    if (req.method === 'GET' && path === '/v1/models') {
      const data = MOCK_MODELS.map((m) => ({ type: 'model', ...m, created_at: '2025-01-01T00:00:00Z' }))
      return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id })
    }
    const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && modelMatch) {
      const m = MOCK_MODELS.find((x) => x.id === decodeURIComponent(modelMatch[1]))
      return m ? sendJson(res, 200, { type: 'model', ...m, created_at: '2025-01-01T00:00:00Z' }) : sendJson(res, 404, errorBody('not_found_error', 'model not found'))
    }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      const b = (body ?? {}) as MessagesRequest
      return sendJson(res, 200, { input_tokens: estimateTokens([b.system, b.messages, b.tools]) })
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      const b = (body && typeof body === 'object' ? body : {}) as MessagesRequest
      const result = runScript({ req: b, token: tokenOf(req) })
      if (result.kind === 'error') return sendJson(res, result.status, errorBody(result.errorType, result.message))
      const model = b.model ?? 'claude-sonnet-4-5'
      const inputTokens = estimateTokens([b.system, b.messages])
      // `[[script:… delay=80]]` slows this stream down (to observe streaming in the UI).
      const delay = Number(findScript(b)?.params.delay ?? delayMs)
      if (b.stream) return streamReply(res, result, model, inputTokens, Number.isFinite(delay) ? delay : delayMs)
      return sendJson(res, 200, {
        id: `msg_mock_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: finalContent(result.blocks),
        stop_reason: result.stopReason,
        stop_sequence: null,
        usage: usage(inputTokens, estimateTokens(result.blocks))
      })
    }
    unknown.push(record)
    log(`  -> 404 (unknown route)`)
    sendJson(res, 404, errorBody('not_found_error', `Not found: ${record.method} ${path}`))
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`  !! ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) sendJson(res, 500, errorBody('api_error', 'mock failure'))
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    unknown,
    messages: () => requests.filter((r) => r.path === '/v1/messages').map((r) => r.body as MessagesRequest),
    reset: () => {
      requests.length = 0
      unknown.length = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
