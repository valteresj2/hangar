// Request adaptation and tool-call repair for non-Claude models (pure; used by the local compat proxy).
//
// Request side: drops what only the Anthropic API understands (effort, context management, adaptive thinking,
// server tools, betas), clamps max_tokens to the model, folds mid-conversation `system` messages into user turns
// and strips Claude's thinking blocks from the history.
// Response side: maps tool names and argument names other harnesses use back to Claude Code's, parses arguments sent
// as strings, coerces scalar types to the schema and drops nulls, in JSON replies and in SSE streams.
import { ARG_SYNONYMS, TOOL_NAME_ALIASES, type ModelTraits } from '../../../../shared/compat'

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- request/response bodies are untyped JSON */

export interface CompatStats {
  requests: number
  adaptedRequests: number
  /** Upstream replies with status >= 400, by status. */
  upstreamErrors: Record<string, number>
  /** Requests sent again with stricter adaptation after a 400. */
  retries: number
  toolCalls: number
  repairs: { name: number; args: number; json: number; nulls: number; types: number }
  /** Text blocks that look like a tool call written as text instead of a real one. */
  textToolCalls: number
  maxTokensStops: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** What adaptRequest changed, by kind (e.g. "effort", "thinking", "system-message"). */
  changes: Record<string, number>
}

export function emptyStats(): CompatStats {
  return {
    requests: 0,
    adaptedRequests: 0,
    upstreamErrors: {},
    retries: 0,
    toolCalls: 0,
    repairs: { name: 0, args: 0, json: 0, nulls: 0, types: 0 },
    textToolCalls: 0,
    maxTokensStops: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    changes: {}
  }
}

// ---- Request ----

export interface ToolSpec {
  name: string
  properties: Record<string, { type?: string | string[] }>
  required: string[]
}

export interface AdaptedRequest {
  body: any
  changes: string[]
  tools: ToolSpec[]
}

const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking'])
const TOOL_FIELDS_ONLY_ANTHROPIC = [
  'defer_loading',
  'input_examples',
  'eager_input_streaming',
  'strict',
  'allowed_callers'
]

export function toolSpecs(tools: any[] | undefined): ToolSpec[] {
  return (tools ?? [])
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      name: t.name,
      properties: (t.input_schema?.properties as ToolSpec['properties']) ?? {},
      required: Array.isArray(t.input_schema?.required) ? t.input_schema.required : []
    }))
}

const asBlocks = (content: unknown): any[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []

/**
 * Adapts a Messages API body (POST /v1/messages or /count_tokens) for a non-Claude model. `strict` also removes
 * fields a stricter gateway may reject (used for the one retry after a 400).
 */
export function adaptRequest(input: any, traits: ModelTraits, opts: { strict?: boolean } = {}): AdaptedRequest {
  const body = structuredClone(input ?? {})
  const changes: string[] = []
  const note = (c: string) => changes.push(c)

  if (body.output_config !== undefined) {
    delete body.output_config
    note('effort')
  }
  if (body.context_management !== undefined) {
    delete body.context_management
    note('context-management')
  }
  if (body.top_k !== undefined) {
    delete body.top_k
    note('top-k')
  }

  if (typeof body.max_tokens === 'number' && body.max_tokens > traits.maxOutputTokens) {
    body.max_tokens = traits.maxOutputTokens
    note('max-tokens')
  }

  if (body.thinking !== undefined) {
    const wanted = body.thinking?.type && body.thinking.type !== 'disabled'
    const limit = typeof body.max_tokens === 'number' ? body.max_tokens : traits.maxOutputTokens
    const budget = Math.min(8_192, Math.floor(limit / 2))
    if (traits.reasoning && wanted && budget >= 1_024 && !opts.strict) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
      note('thinking-budget')
    } else {
      delete body.thinking
      note('thinking')
    }
  }

  if (Array.isArray(body.tools)) {
    const before = body.tools.length
    // Server tools (web_search_…, code_execution_…) run on Anthropic's side only.
    body.tools = body.tools.filter((t: any) => t && (t.type === undefined || t.type === 'custom'))
    if (body.tools.length !== before) note('server-tools')
    for (const t of body.tools) {
      for (const f of TOOL_FIELDS_ONLY_ANTHROPIC) {
        if (t[f] !== undefined) {
          delete t[f]
          note('tool-fields')
        }
      }
    }
    if (!body.tools.length) delete body.tools
    const choice = body.tool_choice
    if (choice?.type === 'tool' && !body.tools?.some((t: any) => t.name === choice.name)) {
      delete body.tool_choice
      note('tool-choice')
    }
  }

  if (Array.isArray(body.messages)) {
    const out: any[] = []
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') continue
      let msg = m
      if (m.role === 'system') {
        // Mid-conversation system messages (reminders, environment) are an Anthropic API feature.
        const text = asBlocks(m.content)
          .map((b) => (b.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('\n')
        msg = { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] }
        note('system-message')
      } else if (m.role === 'assistant' && Array.isArray(m.content)) {
        const kept = m.content.filter((b: any) => !THINKING_BLOCKS.has(b?.type))
        if (kept.length !== m.content.length) {
          note('thinking-history')
          msg = { ...m, content: kept.length ? kept : [{ type: 'text', text: '…' }] }
        }
      }
      const prev = out[out.length - 1]
      if (prev && prev.role === msg.role) {
        // Consecutive turns of one role (after folding): merge, tool results first as the API requires.
        const merged = [...asBlocks(prev.content), ...asBlocks(msg.content)]
        const results = merged.filter((b) => b.type === 'tool_result')
        prev.content = [...results, ...merged.filter((b) => b.type !== 'tool_result')]
        note('merge-turns')
        continue
      }
      out.push({ ...msg })
    }
    body.messages = out
  }

  if (opts.strict) {
    if (body.metadata !== undefined) delete body.metadata
    stripCacheControl(body)
    if (body.tool_choice?.type === 'auto') delete body.tool_choice
    note('strict')
  }

  return { body, changes, tools: toolSpecs(body.tools) }
}

function stripCacheControl(node: any): void {
  if (Array.isArray(node)) {
    for (const n of node) stripCacheControl(n)
  } else if (node && typeof node === 'object') {
    delete node.cache_control
    for (const v of Object.values(node)) if (v && typeof v === 'object') stripCacheControl(v)
  }
}

/** Upstream 400s that a stricter request may avoid (unsupported fields), as opposed to genuine errors. */
export function isFieldRejection(status: number, text: string): boolean {
  return (
    status === 400 &&
    /extra (inputs?|fields?)|not permitted|unsupported|unrecognized|unknown (parameter|field|argument)|unexpected (keyword|field|parameter)|cache_control|metadata|thinking|reasoning|tool_choice|does not support/i.test(
      text
    )
  )
}

// ---- Tool calls ----

const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')

/** Parses tool arguments a model sent as text: code fences, double encoding, trailing commas. */
export function parseLooseJson(raw: string): { value: unknown; repaired: boolean } | undefined {
  let s = raw.trim()
  if (!s) return { value: {}, repaired: true }
  let repaired = false
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s)
  if (fenced) {
    s = fenced[1]
    repaired = true
  }
  const attempt = (text: string): unknown => {
    let v: unknown = JSON.parse(text)
    // Double-encoded: "{\"a\":1}".
    if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
      v = JSON.parse(v)
      repaired = true
    }
    return v
  }
  try {
    return { value: attempt(s), repaired }
  } catch {
    // fall through
  }
  try {
    return { value: attempt(s.replace(/,\s*([}\]])/g, '$1')), repaired: true }
  } catch {
    return undefined
  }
}

export interface RepairResult {
  name: string
  input: unknown
  repairs: (keyof CompatStats['repairs'])[]
}

/** Matches a tool name the model sent to one of the request's tools. */
export function repairToolName(name: string, tools: ToolSpec[]): string | undefined {
  if (tools.some((t) => t.name === name)) return name
  const bare = name.replace(/^(functions?|tools?|default_api)[.:]/i, '').trim()
  const exact = tools.find((t) => t.name.toLowerCase() === bare.toLowerCase())
  if (exact) return exact.name
  const n = norm(bare)
  const byNorm = tools.find((t) => norm(t.name) === n)
  if (byNorm) return byNorm.name
  for (const [canonical, aliases] of Object.entries(TOOL_NAME_ALIASES)) {
    if (aliases.some((a) => norm(a) === n) && tools.some((t) => t.name === canonical)) return canonical
  }
  return undefined
}

function schemaType(spec: { type?: string | string[] } | undefined): string | undefined {
  const t = spec?.type
  return Array.isArray(t) ? t.find((x) => x !== 'null') : t
}

/** Repairs one tool call against the request's tool schemas. Unknown tools are left for Claude Code to report. */
export function repairToolCall(name: string, rawInput: unknown, tools: ToolSpec[]): RepairResult {
  const repairs: RepairResult['repairs'] = []
  const fixedName = repairToolName(name, tools) ?? name
  if (fixedName !== name) repairs.push('name')

  let input = rawInput
  if (typeof input === 'string') {
    const parsed = parseLooseJson(input)
    if (parsed && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      input = parsed.value
      repairs.push('json')
    }
  }
  const spec = tools.find((t) => t.name === fixedName)
  if (!spec || !input || typeof input !== 'object' || Array.isArray(input)) return { name: fixedName, input, repairs }

  const props = Object.keys(spec.properties)
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  let renamed = false
  for (const key of Object.keys(out)) {
    if (props.includes(key)) continue
    const n = norm(key)
    // filePath → file_path, OldString → old_string…
    let target = props.find((p) => norm(p) === n && !(p in out))
    // path → file_path, old_str → old_string… (only into a property the call does not set)
    target ??= props.find((p) => !(p in out) && (ARG_SYNONYMS[p] ?? []).some((s) => norm(s) === n))
    if (target) {
      out[target] = out[key]
      delete out[key]
      renamed = true
    }
  }
  if (renamed) repairs.push('args')

  let nulls = false
  let types = false
  for (const [key, value] of Object.entries(out)) {
    if (value === null && !spec.required.includes(key)) {
      delete out[key]
      nulls = true
      continue
    }
    const type = schemaType(spec.properties[key])
    if (typeof value !== 'string' || !type) continue
    if ((type === 'number' || type === 'integer') && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
      out[key] = Number(value)
      types = true
    } else if (type === 'boolean' && /^(true|false)$/i.test(value.trim())) {
      out[key] = value.trim().toLowerCase() === 'true'
      types = true
    } else if (type === 'array' || type === 'object') {
      const parsed = parseLooseJson(value)
      if (parsed && typeof parsed.value === 'object' && parsed.value !== null) {
        out[key] = parsed.value
        types = true
      }
    }
  }
  if (nulls) repairs.push('nulls')
  if (types) repairs.push('types')
  return { name: fixedName, input: out, repairs }
}

const TEXT_TOOL_CALL =
  /<tool_call>|<function[=\s]|<\|tool_call|"(name|tool)"\s*:\s*"[^"]+"\s*,\s*"(arguments|parameters|input)"\s*:/i

export function looksLikeTextToolCall(text: string): boolean {
  return TEXT_TOOL_CALL.test(text)
}

function countUsage(stats: CompatStats, usage: any): void {
  if (!usage || typeof usage !== 'object') return
  if (typeof usage.input_tokens === 'number') stats.inputTokens += usage.input_tokens
  if (typeof usage.output_tokens === 'number') stats.outputTokens += usage.output_tokens
  if (typeof usage.cache_read_input_tokens === 'number') stats.cacheReadTokens += usage.cache_read_input_tokens
}

function noteRepairs(stats: CompatStats, repairs: RepairResult['repairs']): void {
  for (const r of repairs) stats.repairs[r]++
}

/** Repairs the tool calls of a non-streaming Messages API reply. */
export function repairMessage(message: any, tools: ToolSpec[], stats: CompatStats): any {
  if (!message || !Array.isArray(message.content)) return message
  countUsage(stats, message.usage)
  if (message.stop_reason === 'max_tokens') stats.maxTokensStops++
  for (const block of message.content) {
    if (block?.type === 'tool_use') {
      stats.toolCalls++
      const r = repairToolCall(block.name, block.input, tools)
      block.name = r.name
      block.input = r.input
      noteRepairs(stats, r.repairs)
    } else if (block?.type === 'text' && typeof block.text === 'string' && looksLikeTextToolCall(block.text)) {
      stats.textToolCalls++
    }
  }
  return message
}

/**
 * Rewrites an Anthropic SSE stream: tool_use argument deltas are held until the block ends and sent as one repaired
 * delta (Claude Code parses arguments only at content_block_stop); every other event passes through unchanged.
 */
export class SseRewriter {
  private buffer = ''
  private readonly blocks = new Map<number, { name: string; json: string } | { text: string }>()

  constructor(
    private readonly tools: ToolSpec[],
    private readonly stats: CompatStats
  ) {}

  /** Feeds decoded text; returns what to send downstream now. */
  push(chunk: string): string {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    let out = ''
    let cut: number
    while ((cut = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, cut + 2)
      this.buffer = this.buffer.slice(cut + 2)
      out += this.event(raw)
    }
    return out
  }

  /** The rest at end of stream. */
  end(): string {
    const rest = this.buffer
    this.buffer = ''
    return rest ? this.event(rest.endsWith('\n\n') ? rest : `${rest}\n\n`) : ''
  }

  private event(raw: string): string {
    const dataLines = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
    if (!dataLines.length) return raw
    let data: any
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return raw
    }
    const emit = (d: any) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`
    switch (data?.type) {
      case 'message_start':
        // message_delta carries the cumulative output count; the start's is a placeholder.
        countUsage(this.stats, { ...data.message?.usage, output_tokens: undefined })
        return raw
      case 'message_delta':
        countUsage(this.stats, { output_tokens: data.usage?.output_tokens })
        if (data.delta?.stop_reason === 'max_tokens') this.stats.maxTokensStops++
        return raw
      case 'content_block_start': {
        const block = data.content_block
        if (block?.type === 'tool_use') {
          this.stats.toolCalls++
          const initial = block.input && typeof block.input === 'object' && Object.keys(block.input).length
          this.blocks.set(data.index, { name: block.name, json: initial ? JSON.stringify(block.input) : '' })
          return emit({
            ...data,
            content_block: { ...block, name: repairToolName(block.name, this.tools) ?? block.name, input: {} }
          })
        }
        if (block?.type === 'text') this.blocks.set(data.index, { text: block.text ?? '' })
        return raw
      }
      case 'content_block_delta': {
        const tracked = this.blocks.get(data.index)
        if (tracked && 'json' in tracked && data.delta?.type === 'input_json_delta') {
          tracked.json += data.delta.partial_json ?? ''
          return ''
        }
        if (tracked && 'text' in tracked && data.delta?.type === 'text_delta') tracked.text += data.delta.text ?? ''
        return raw
      }
      case 'content_block_stop': {
        const tracked = this.blocks.get(data.index)
        this.blocks.delete(data.index)
        if (tracked && 'text' in tracked) {
          if (looksLikeTextToolCall(tracked.text)) this.stats.textToolCalls++
          return raw
        }
        if (!tracked) return raw
        const parsed = parseLooseJson(tracked.json)
        const r = repairToolCall(tracked.name, parsed ? parsed.value : tracked.json, this.tools)
        if (parsed?.repaired && tracked.json.trim()) r.repairs.push('json')
        noteRepairs(this.stats, r.repairs)
        const json = typeof r.input === 'string' ? r.input : JSON.stringify(r.input ?? {})
        return (
          emit({
            type: 'content_block_delta',
            index: data.index,
            delta: { type: 'input_json_delta', partial_json: json }
          }) + raw
        )
      }
      default:
        return raw
    }
  }
}
