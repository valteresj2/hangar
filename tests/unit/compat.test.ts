// Compat layer for non-Claude models: model detection, request adaptation, tool-call repair (JSON and SSE), the
// launch-time options, and the local proxy end to end against a fake gateway.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- assertions on untyped JSON bodies */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { isClaudeModel, modelTraits, resolveModelAlias } from '../../src/shared/compat'
import {
  adaptRequest,
  emptyStats,
  parseLooseJson,
  repairMessage,
  repairToolCall,
  SseRewriter,
  toolSpecs
} from '../../src/main/features/engine/compat/transform'
import { compatSession } from '../../src/main/features/engine/compat'
import {
  registerRoute,
  routeStats,
  startCompatProxy,
  stopCompatProxy
} from '../../src/main/features/engine/compat/proxy'

const TOOLS = [
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['file_path']
    }
  },
  {
    name: 'Edit',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
]
const specs = toolSpecs(TOOLS)

describe('model detection', () => {
  it('tells Claude ids from others', () => {
    for (const m of ['claude-sonnet-4-5', 'us.anthropic.claude-opus-4-1', 'anthropic/claude-3.5', 'sonnet', 'opus[1m]'])
      expect(isClaudeModel(m), m).toBe(true)
    for (const m of ['gpt-4.1-mini', 'openai/gpt-4o', 'qwen3-coder', 'deepseek-chat', 'llama-3.3-70b', 'my-model'])
      expect(isClaudeModel(m), m).toBe(false)
  })

  it('looks up limits, with the profile overriding them', () => {
    expect(modelTraits('openai/gpt-4o-mini')).toMatchObject({ adapted: true, maxOutputTokens: 16_384, source: 'table' })
    expect(modelTraits('something-new')).toMatchObject({ adapted: true, contextWindow: 128_000, source: 'default' })
    expect(modelTraits('qwen2.5-coder')).toMatchObject({ contextWindow: 100_000 })
    expect(modelTraits('x', { contextWindow: 300_000, maxOutputTokens: 4096 })).toMatchObject({
      contextWindow: 300_000,
      maxOutputTokens: 4096,
      source: 'profile'
    })
    expect(modelTraits('claude-sonnet-4-5').adapted).toBe(false)
    expect(modelTraits('claude-sonnet-4-5', { mode: 'on' }).adapted).toBe(true)
    expect(modelTraits('gpt-4o', { mode: 'off' }).adapted).toBe(false)
  })

  it('resolves composer aliases through the profile mapping', () => {
    expect(resolveModelAlias('sonnet', { sonnet: 'gpt-4.1' })).toBe('gpt-4.1')
    expect(resolveModelAlias('opus[1m]', {})).toBe('opus[1m]')
    expect(resolveModelAlias(undefined, { default: 'qwen3-coder' })).toBe('qwen3-coder')
    expect(resolveModelAlias('gpt-5', { sonnet: 'x' })).toBe('gpt-5')
  })
})

describe('adaptRequest', () => {
  const body = {
    model: 'gpt-4o',
    max_tokens: 32000,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
    context_management: { edits: [] },
    tools: [
      ...TOOLS,
      { type: 'web_search_20250305', name: 'web_search' },
      { ...TOOLS[0], name: 'Deferred', defer_loading: true }
    ],
    messages: [
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      { role: 'system', content: [{ type: 'text', text: 'cwd: /w' }] }
    ]
  }

  it('drops Anthropic-only fields and clamps max_tokens', () => {
    const { body: out, changes } = adaptRequest(body, modelTraits('gpt-4o'))
    expect(out.output_config).toBeUndefined()
    expect(out.context_management).toBeUndefined()
    expect(out.thinking).toBeUndefined()
    expect(out.max_tokens).toBe(16_384)
    expect(out.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Edit', 'Bash', 'Deferred'])
    expect(out.tools[3].defer_loading).toBeUndefined()
    expect(changes).toEqual(
      expect.arrayContaining(['effort', 'context-management', 'thinking', 'max-tokens', 'server-tools'])
    )
    // The input is not modified.
    expect(body.output_config).toBeDefined()
  })

  it('folds system messages into the user turn and drops thinking from the history', () => {
    const { body: out } = adaptRequest(body, modelTraits('gpt-4o'))
    expect(out.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['tool_use'])
    const last = out.messages[2].content
    expect(last[0].type).toBe('tool_result')
    expect(last[1].text).toContain('<system-reminder>\ncwd: /w')
  })

  it('turns thinking into a budget for reasoning models; strict also strips cache_control and metadata', () => {
    const reasoning = adaptRequest(body, modelTraits('gpt-5-mini'))
    expect(reasoning.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    const strict = adaptRequest(
      {
        ...body,
        metadata: { user_id: 'u' },
        system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]
      },
      modelTraits('gpt-5-mini'),
      { strict: true }
    )
    expect(strict.body.thinking).toBeUndefined()
    expect(strict.body.metadata).toBeUndefined()
    expect(strict.body.system[0].cache_control).toBeUndefined()
  })
})

describe('tool-call repair', () => {
  it('parses loose JSON', () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false })
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ value: { a: 1 }, repaired: true })
    expect(parseLooseJson('"{\\"a\\":1}"')).toEqual({ value: { a: 1 }, repaired: true })
    expect(parseLooseJson('{"a":[1,2,],}')).toEqual({ value: { a: [1, 2] }, repaired: true })
    expect(parseLooseJson('')).toEqual({ value: {}, repaired: true })
    expect(parseLooseJson('{nope')).toBeUndefined()
  })

  it('maps names, argument names, types and nulls to the schema', () => {
    expect(repairToolCall('read_file', { path: '/a', offset: '10', limit: null }, specs)).toEqual({
      name: 'Read',
      input: { file_path: '/a', offset: 10 },
      repairs: ['name', 'args', 'nulls', 'types']
    })
    expect(
      repairToolCall('functions.edit', '{"filePath":"/a","old_str":"x","new_str":"y","replace_all":"false"}', specs)
    ).toEqual({
      name: 'Edit',
      input: { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false },
      repairs: ['name', 'json', 'args', 'types']
    })
    expect(repairToolCall('run_shell_command', { cmd: 'ls' }, specs)).toMatchObject({
      name: 'Bash',
      input: { command: 'ls' }
    })
    // A correct call is left alone; an unknown tool is left for Claude Code to report.
    expect(repairToolCall('Bash', { command: 'ls' }, specs).repairs).toEqual([])
    expect(repairToolCall('Teleport', { to: 'x' }, specs)).toEqual({
      name: 'Teleport',
      input: { to: 'x' },
      repairs: []
    })
  })

  it('repairs a JSON reply and counts text-written tool calls', () => {
    const stats = emptyStats()
    const msg = repairMessage(
      {
        content: [
          { type: 'text', text: '<tool_call>{"name":"Bash"}</tool_call>' },
          { type: 'tool_use', id: 't', name: 'bash', input: { cmd: 'dir' } }
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 7 }
      },
      specs,
      stats
    )
    expect(msg.content[1]).toMatchObject({ name: 'Bash', input: { command: 'dir' } })
    expect(stats).toMatchObject({ toolCalls: 1, textToolCalls: 1, inputTokens: 100, outputTokens: 7 })
  })

  it('repairs tool calls in an SSE stream split at arbitrary points', () => {
    const ev = (d: object) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`
    const stream =
      ev({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } }) +
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Lendo.' } }) +
      ev({ type: 'content_block_stop', index: 0 }) +
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't', name: 'read_file', input: {} }
      }) +
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }) +
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'th": "/x", "limit": "5"}' }
      }) +
      ev({ type: 'content_block_stop', index: 1 }) +
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }) +
      ev({ type: 'message_stop' })
    const stats = emptyStats()
    const sse = new SseRewriter(specs, stats)
    let out = ''
    for (let i = 0; i < stream.length; i += 7) out += sse.push(stream.slice(i, i + 7))
    out += sse.end()
    const events = out
      .split('\n\n')
      .filter(Boolean)
      .map((e) =>
        JSON.parse(
          e
            .split('\n')
            .find((l) => l.startsWith('data:'))!
            .slice(5)
        )
      )
    const start = events.find((e) => e.type === 'content_block_start' && e.index === 1)
    expect(start.content_block.name).toBe('Read')
    const deltas = events.filter((e) => e.type === 'content_block_delta' && e.index === 1)
    expect(deltas).toHaveLength(1)
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ file_path: '/x', limit: 5 })
    expect(events.find((e) => e.type === 'content_block_delta' && e.index === 0).delta.text).toBe('Lendo.')
    expect(stats).toMatchObject({ toolCalls: 1, inputTokens: 50, outputTokens: 20 })
    expect(stats.repairs).toMatchObject({ name: 1, args: 1, types: 1 })
  })
})

describe('compatSession', () => {
  const gateway = (extra: object = {}) => ({ kind: 'gateway' as const, env: {}, ...extra })

  it('adapts non-Claude models on gateways only', () => {
    expect(compatSession({ kind: 'anthropic', env: {} }, 'gpt-4o').adapted).toBe(false)
    expect(compatSession(gateway(), 'claude-sonnet-4-5').adapted).toBe(false)
    expect(compatSession(gateway({ compat: { mode: 'off' } }), 'gpt-4o').adapted).toBe(false)
    // "sonnet" mapped to a GPT model is a GPT session.
    expect(compatSession(gateway({ models: { sonnet: 'gpt-4.1' } }), 'sonnet').adapted).toBe(true)
  })

  it('sets limits, background model, core tools and no effort', () => {
    const c = compatSession(gateway(), 'gpt-4o', 'linux')
    expect(c.env).toMatchObject({
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-4o'
    })
    expect(c.tools).toContain('Edit')
    expect(c.tools).not.toContain('Task')
    expect(c.thinking).toEqual({ type: 'disabled' })
    expect(c.dropEffort).toBe(true)
    expect(c.append).toContain('Bash tool')
    expect(compatSession(gateway(), 'gpt-4o', 'win32').append).toContain('PowerShell')
    // The profile's own variables and mappings win; full toolset keeps Claude Code's default.
    const own = compatSession(
      gateway({
        env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' },
        models: { haiku: 'gpt-4o-mini' },
        compat: { toolset: 'full' }
      }),
      'gpt-4o'
    )
    expect(own.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
    expect(own.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(own.tools).toBeUndefined()
    expect(compatSession(gateway(), 'gpt-5').thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })
})

describe('compat proxy', () => {
  const seen: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = []
  let reject400 = false
  const gateway = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      if (body.thinking && String(body.model).includes('openrouter/')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            error: { message: "litellm.UnsupportedParamsError: openrouter does not support parameters: ['thinking']" }
          })
        )
      }
      if (reject400 && body.metadata) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'metadata: Extra inputs are not permitted' } }))
      }
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [] }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'bash', input: '{"cmd":"ls"}' }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 2 }
        })
      )
    })
  })
  let upstream = ''
  afterAll(async () => {
    await stopCompatProxy()
    await new Promise((r) => gateway.close(r))
  })

  const post = (url: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'anthropic-beta': 'x',
        ...headers
      },
      body: JSON.stringify(body)
    })

  it('adapts non-Claude requests, repairs the reply and passes credentials and Claude requests through', async () => {
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()))
    upstream = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
    await startCompatProxy()
    const route = registerRoute(upstream, undefined, false)

    const reply = await (
      await post(route.url, {
        model: 'gpt-4o',
        max_tokens: 32000,
        output_config: { effort: 'high' },
        tools: TOOLS,
        messages: [{ role: 'user', content: 'oi' }]
      })
    ).json()
    expect(reply.content[0]).toMatchObject({ name: 'Bash', input: { command: 'ls' } })
    const adapted = seen.at(-1)!
    expect(adapted.path).toBe('/v1/messages')
    expect(adapted.body.output_config).toBeUndefined()
    expect(adapted.body.max_tokens).toBe(16_384)
    expect(adapted.headers.authorization).toBe('Bearer test-key')
    expect(adapted.headers['anthropic-beta']).toBeUndefined()

    await post(route.url, {
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,
      output_config: { effort: 'high' },
      messages: []
    })
    expect(seen.at(-1)!.body.output_config).toEqual({ effort: 'high' })
    expect(seen.at(-1)!.headers['anthropic-beta']).toBe('x')

    expect((await fetch(`${route.url}/v1/models`)).status).toBe(200)
    expect((await fetch(route.url.replace(route.id, 'nope') + '/v1/models')).status).toBe(404)
    expect(routeStats(route.id)).toMatchObject({
      requests: 3,
      adaptedRequests: 1,
      toolCalls: 1,
      repairs: { name: 1, args: 1, json: 1 }
    })
  })

  it('learns to adapt a Claude model whose gateway route rejects Anthropic-only fields', async () => {
    const route = registerRoute(upstream, undefined, false)
    const claude = 'openrouter/anthropic/claude-haiku-5.5'
    const body = {
      model: claude,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'oi' }]
    }
    expect((await post(route.url, body)).status).toBe(200)
    const sent = seen.at(-1)!.body
    expect(sent.thinking).toBeUndefined()
    // A Claude model keeps its own output limit.
    expect(sent.max_tokens).toBe(32000)
    const before = seen.length
    expect((await post(route.url, body)).status).toBe(200)
    // Learned: the second request goes adapted on the first try.
    expect(seen.length).toBe(before + 1)
    expect(routeStats(route.id)).toMatchObject({ retries: 1, changes: { learned: 1 }, upstreamErrors: {} })
  })

  it('retries once with strict adaptation when the gateway rejects a field', async () => {
    reject400 = true
    const route = registerRoute(upstream, undefined, false)
    const res = await post(route.url, {
      model: 'gpt-4o',
      max_tokens: 100,
      metadata: { user_id: 'u' },
      messages: [{ role: 'user', content: 'oi' }]
    })
    expect(res.status).toBe(200)
    expect(seen.at(-1)!.body.metadata).toBeUndefined()
    expect(routeStats(route.id)).toMatchObject({ retries: 1, upstreamErrors: {} })
    reject400 = false
  })
})
