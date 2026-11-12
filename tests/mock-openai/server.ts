// A scripted OpenAI-compatible chat server for the Hangar engine tests (unit and e2e): each request pops the next
// step of `script` and streams it as SSE. No network, no API key.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockStep =
  { text: string; delayMs?: number } | { tool: string; args: Record<string, unknown>; thinking?: string }

export interface MockOpenAI {
  /** Base URL as a gateway profile stores it (no /v1): the engine appends /v1 itself. */
  url: string
  script: MockStep[]
  requests: { path: string; auth?: string; body: { model?: string; messages: { role: string; content: unknown }[] } }[]
  close(): Promise<void>
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export async function startMockOpenAI(): Promise<MockOpenAI> {
  const mock: MockOpenAI = { url: '', script: [], requests: [], close: () => Promise.resolve() }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = (await readJson(req)) as MockOpenAI['requests'][number]['body']
      mock.requests.push({ path: req.url ?? '', auth: req.headers.authorization, body })
      const step: MockStep = mock.script.shift() ?? { text: 'ok' }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      let finish = 'stop'
      if ('tool' in step) {
        if (step.thinking) sse({ choices: [{ delta: { reasoning: step.thinking } }] })
        const call = {
          index: 0,
          id: `call_${mock.requests.length}`,
          function: { name: step.tool, arguments: JSON.stringify(step.args) }
        }
        sse({ choices: [{ delta: { tool_calls: [call] } }] })
        finish = 'tool_calls'
      } else {
        for (const word of step.text.split(' ')) {
          if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
          if (res.destroyed) return
          sse({ choices: [{ delta: { content: `${word} ` } }] })
        }
      }
      sse({
        choices: [{ delta: {}, finish_reason: finish }],
        usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0015 }
      })
      res.end('data: [DONE]\n\n')
    })().catch(() => res.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.close = () => new Promise((r) => server.close(() => r()))
  return mock
}
