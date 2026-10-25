// The fake Anthropic server used by the E2E tests: protocol shape and scripts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockAnthropic, type MockAnthropic } from '../mock-anthropic/server.ts'
import { findScript, TEXT_REPLY } from '../mock-anthropic/scripts.ts'

let mock: MockAnthropic
beforeAll(async () => {
  mock = await startMockAnthropic({ eventDelayMs: 0 })
})
afterAll(() => mock.close())

const headers = (token = 'mock-token') => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'anthropic-version': '2023-06-01'
})

async function post(path: string, body: unknown, token?: string) {
  return fetch(mock.url + path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) })
}

interface SseEvent {
  event: string
  data: Record<string, any>
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)![1]
      const data = JSON.parse(/^data: (.+)$/m.exec(chunk)![1])
      return { event, data }
    })
}

/** Rebuilds the final content blocks from a stream, like an SDK would. */
function assemble(events: SseEvent[]) {
  const blocks: Record<string, any>[] = []
  const json: string[] = []
  for (const { data } of events) {
    if (data.type === 'content_block_start') {
      blocks[data.index] = { ...data.content_block }
      json[data.index] = ''
    } else if (data.type === 'content_block_delta') {
      const b = blocks[data.index]
      const d = data.delta
      if (d.type === 'text_delta') b.text += d.text
      else if (d.type === 'thinking_delta') b.thinking += d.thinking
      else if (d.type === 'signature_delta') b.signature = d.signature
      else if (d.type === 'input_json_delta') json[data.index] += d.partial_json
    } else if (data.type === 'content_block_stop' && blocks[data.index].type === 'tool_use') {
      blocks[data.index].input = JSON.parse(json[data.index])
    }
  }
  return blocks
}

const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

describe('mock Anthropic server', () => {
  it('non-streaming text reply has the Message shape', async () => {
    const res = await post('/v1/messages', { model: 'claude-x', max_tokens: 10, messages: [userMsg('oi')] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: TEXT_REPLY }]
    })
    expect(body.usage.input_tokens).toBeGreaterThan(0)
  })

  it('streams events in protocol order', async () => {
    const res = await post('/v1/messages', { stream: true, messages: [userMsg('[[script:thinking]] pense')] })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = parseSse(await res.text())
    for (const e of events) expect(e.data.type).toBe(e.event)
    const names = events.map((e) => e.event).filter((e) => e !== 'ping' && e !== 'content_block_delta')
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_stop',
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[0].data.message).toMatchObject({ role: 'assistant', content: [], stop_reason: null })
    const blocks = assemble(events)
    expect(blocks[0]).toMatchObject({
      type: 'thinking',
      thinking: expect.stringContaining('Pensando'),
      signature: expect.stringMatching(/^mock-signature-/)
    })
    expect(blocks[1]).toEqual({ type: 'text', text: 'Resposta depois de pensar.' })
    expect(events.find((e) => e.event === 'message_delta')!.data).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: expect.any(Number) }
    })
  })

  it('write-file: tool_use with input_json_delta, then finishes after the tool_result', async () => {
    const system = [{ type: 'text', text: 'You are Claude Code.' }]
    const tools = [{ name: 'Write' }, { name: 'Read' }]
    const first = [
      { role: 'system', content: 'Primary working directory: C:\\proj' },
      userMsg('[[script:write-file path=out/a.html]] crie')
    ]
    const events = parseSse(await (await post('/v1/messages', { stream: true, system, tools, messages: first })).text())
    const blocks = assemble(events)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Vou criar o arquivo out/a.html.' })
    expect(blocks[1]).toMatchObject({
      type: 'tool_use',
      name: 'Write',
      input: { file_path: 'C:\\proj\\out\\a.html', content: expect.stringContaining('<h1>') }
    })
    expect(events.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use')

    const second = [
      ...first,
      { role: 'assistant', content: blocks },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: blocks[1].id, content: 'File created successfully' }]
      },
      { role: 'system', content: [{ type: 'text', text: '<reminder/>' }] }
    ]
    const done = await (await post('/v1/messages', { tools, messages: second })).json()
    expect(done).toMatchObject({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Pronto: out/a.html foi criado.' }]
    })
  })

  it('shell script uses PowerShell when Bash is not offered', async () => {
    const body = await (
      await post('/v1/messages', {
        tools: [{ name: 'PowerShell' }],
        messages: [userMsg('[[script:shell command=dir]]')]
      })
    ).json()
    expect(body.content[1]).toMatchObject({ type: 'tool_use', name: 'PowerShell', input: { command: 'dir' } })
  })

  it('a later turn without a marker does not replay an earlier script', () => {
    expect(
      findScript({
        messages: [
          userMsg('[[script:write-file]]'),
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          userMsg('e agora?')
        ]
      } as never)
    ).toBeUndefined()
  })

  it('errors: by marker and by token', async () => {
    const r401 = await post('/v1/messages', { messages: [userMsg('oi')] }, 'mock-token-401')
    expect(r401.status).toBe(401)
    expect(await r401.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    const r500 = await post('/v1/messages', { messages: [userMsg('[[script:error-500]]')] })
    expect(r500.status).toBe(500)
    expect((await r500.json()).error.type).toBe('api_error')
  })

  it('selector prompts get a ```choice``` naming the first candidate', async () => {
    const prompt =
      'Pick one.\n<candidate id="A">x</candidate>\n<candidate id="B">y</candidate>\n```choice\n<the id of the single candidate to deliver>\n```'
    const body = await (await post('/v1/messages', { messages: [userMsg(prompt)] })).json()
    expect(body.content[0].text).toMatch(/<why>[\s\S]*<\/why>[\s\S]*```choice\nA\n```/)
  })

  it('count_tokens, models and controlled 404s', async () => {
    expect(await (await post('/v1/messages/count_tokens', { messages: [userMsg('hello')] })).json()).toEqual({
      input_tokens: expect.any(Number)
    })
    const models = await (await fetch(`${mock.url}/v1/models`, { headers: headers() })).json()
    expect(models.data.map((m: { id: string }) => m.id)).toContain('claude-sonnet-4-5')
    expect((await fetch(`${mock.url}/v1/models/claude-haiku-4-5`)).status).toBe(200)
    const before = mock.unknown.length
    const nf = await fetch(`${mock.url}/api/oauth/profile`)
    expect(nf.status).toBe(404)
    expect((await nf.json()).error.type).toBe('not_found_error')
    expect(mock.unknown.slice(before).map((r) => r.path)).toEqual(['/api/oauth/profile'])
  })
})
