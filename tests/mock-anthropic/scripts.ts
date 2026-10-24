// Deterministic "model" behaviour for the mock Anthropic server.
//
// A script is picked by a marker in the conversation, e.g. `[[script:write-file path=hello.html]]`
// (the most recent marker in a user message wins), or by the auth token (`mock-token-401`, `mock-token-500`).
// Without a marker the reply is plain streamed text, which also covers Claude Code's auxiliary requests
// (titles, summaries…).

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export interface ScriptReply {
  kind: 'message'
  blocks: Block[]
  stopReason: StopReason
}

export interface ScriptError {
  kind: 'error'
  status: number
  errorType: string
  message: string
}

export type ScriptResult = ScriptReply | ScriptError

/** The subset of a Messages API request the scripts look at. */
export interface MessagesRequest {
  model?: string
  system?: string | { type: string; text?: string }[]
  /** Claude Code also sends mid-conversation `system` messages (environment, reminders). */
  messages?: { role: 'user' | 'assistant' | 'system'; content: string | Record<string, unknown>[] }[]
  tools?: { name?: string }[]
  stream?: boolean
  max_tokens?: number
}

export interface ScriptContext {
  req: MessagesRequest
  /** Bearer token or x-api-key the client sent. */
  token: string | undefined
}

export const MARKER = /\[\[script:([a-z0-9-]+)((?:\s+[a-z_]+=[^\s\]]+)*)\s*\]\]/gi

export const TEXT_REPLY = 'Olá! Esta resposta veio do servidor Anthropic falso do Hangar, em pedaços, para testar o streaming.'

let toolSeq = 0
const toolId = () => `toolu_mock_${Date.now().toString(36)}_${(toolSeq++).toString(36)}`

/** Plain text of a message content (string, or the text blocks of an array; tool results excluded). */
export function contentText(content: string | Record<string, unknown>[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function systemText(req: MessagesRequest): string {
  if (typeof req.system === 'string') return req.system
  if (Array.isArray(req.system)) return req.system.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

function hasToolResult(content: string | Record<string, unknown>[]): boolean {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')
}

/**
 * The `[[script:…]]` marker of the latest human turn (the last user message that is not a tool result),
 * with its key=value parameters. Earlier turns' markers are ignored so a finished script never replays.
 */
export function findScript(req: MessagesRequest): { name: string; params: Record<string, string> } | undefined {
  const messages = req.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user' || hasToolResult(messages[i].content)) continue
    const matches = [...contentText(messages[i].content).matchAll(MARKER)]
    const m = matches[matches.length - 1]
    if (!m) return undefined
    const params: Record<string, string> = {}
    for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
      const eq = pair.indexOf('=')
      params[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    return { name: m[1].toLowerCase(), params }
  }
  return undefined
}

/** tool_result blocks sent after the last assistant message (the answers to our previous tool_use). */
export function lastToolResults(req: MessagesRequest): { tool_use_id: string; is_error?: boolean; text: string }[] {
  const messages = req.messages ?? []
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== 'assistant') i--
  return messages
    .slice(i + 1)
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content as Record<string, unknown>[])
    .filter((b) => b && b.type === 'tool_result')
    .map((b) => ({
      tool_use_id: String(b.tool_use_id),
      is_error: b.is_error === true,
      text: typeof b.content === 'string' ? b.content : contentText(b.content as Record<string, unknown>[])
    }))
}

function hasTool(req: MessagesRequest, name: string): boolean {
  return (req.tools ?? []).some((t) => t.name === name)
}

/** Working directory announced in Claude Code's system prompt ("Primary working directory: …"). */
export function workingDirectory(req: MessagesRequest): string | undefined {
  const text = systemText(req) + '\n' + (req.messages ?? []).map((m) => contentText(m.content)).join('\n')
  const m = /(?:Primary working directory|Working directory):\s*(.+)/i.exec(text)
  return m?.[1].trim()
}

function joinPath(dir: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]/g, sep)
}

const text = (t: string): ScriptReply => ({ kind: 'message', blocks: [{ type: 'text', text: t }], stopReason: 'end_turn' })

/** Two-step tool script: ask for `tool` with `input`, then finish once the tool_result arrives. */
function toolScript(ctx: ScriptContext, tool: string, input: Record<string, unknown>, intro: string, done: (r: { is_error?: boolean; text: string }) => string): ScriptResult {
  const results = lastToolResults(ctx.req)
  if (results.length) return text(done(results[0]))
  if (!hasTool(ctx.req, tool)) return text(`(mock) a ferramenta ${tool} não foi oferecida nesta requisição.`)
  return {
    kind: 'message',
    blocks: [
      { type: 'text', text: intro },
      { type: 'tool_use', id: toolId(), name: tool, input }
    ],
    stopReason: 'tool_use'
  }
}

/** Blind selector of the Harness Lab: answers with <why> and a ```choice``` block naming the first candidate. */
function selectorReply(ctx: ScriptContext): ScriptReply | undefined {
  const all = (ctx.req.messages ?? []).map((m) => contentText(m.content)).join('\n')
  if (!/```choice/.test(all) || !/<candidate id="/.test(all)) return undefined
  const ids = [...all.matchAll(/<candidate id="([A-Z]+)">/g)].map((m) => m[1])
  return text(`<why>\nMock: escolheu o primeiro candidato (${ids[0]}).\n</why>\n\n\`\`\`choice\n${ids[0]}\n\`\`\``)
}

export function runScript(ctx: ScriptContext): ScriptResult {
  if (ctx.token === 'mock-token-401') return { kind: 'error', status: 401, errorType: 'authentication_error', message: 'invalid x-api-key' }
  if (ctx.token === 'mock-token-500') return { kind: 'error', status: 500, errorType: 'api_error', message: 'Internal server error' }

  const script = findScript(ctx.req)
  const selector = selectorReply(ctx)
  if (selector && !script) return selector

  switch (script?.name) {
    case undefined:
      return text(TEXT_REPLY)
    case 'text': {
      // `repeat=N` makes a long reply (numbered parts), e.g. to watch streaming across several CLI flushes.
      const n = Math.min(Math.max(Number(script.params.repeat ?? 1) || 1, 1), 200)
      return text(n === 1 ? TEXT_REPLY : Array.from({ length: n }, (_, i) => `Parte ${i + 1}. ${TEXT_REPLY}`).join('\n\n'))
    }

    case 'thinking':
      return {
        kind: 'message',
        blocks: [
          { type: 'thinking', thinking: 'Pensando no pedido de teste: basta responder com um texto curto.', signature: 'mock-signature-' + 'x'.repeat(40) },
          { type: 'text', text: 'Resposta depois de pensar.' }
        ],
        stopReason: 'end_turn'
      }

    case 'write-file': {
      const rel = script.params.path ?? 'hangar-mock.html'
      const cwd = workingDirectory(ctx.req)
      const filePath = cwd ? joinPath(cwd, rel) : rel
      const body =
        script.params.content ??
        (rel.endsWith('.html')
          ? '<!doctype html>\n<html><head><meta charset="utf-8"><title>Mock</title></head>\n<body><h1>Criado pelo mock</h1></body></html>\n'
          : 'Arquivo criado pelo servidor Anthropic falso.\n')
      return toolScript(ctx, 'Write', { file_path: filePath, content: body }, `Vou criar o arquivo ${rel}.`, (r) =>
        r.is_error ? `Não consegui escrever ${rel}: ${r.text.slice(0, 200)}` : `Pronto: ${rel} foi criado.`
      )
    }

    case 'shell':
    case 'bash':
      // Claude Code offers Bash, or PowerShell on Windows without Git Bash.
      return toolScript(
        ctx,
        hasTool(ctx.req, 'Bash') || !hasTool(ctx.req, 'PowerShell') ? 'Bash' : 'PowerShell',
        { command: script.params.command ?? 'echo hangar-mock-shell', description: 'Comando de teste do mock' },
        'Vou rodar um comando.',
        (r) => (r.is_error ? `O comando não rodou: ${r.text.slice(0, 200)}` : `Saída do comando: ${r.text.trim().slice(0, 200)}`)
      )

    case 'error-401':
      return { kind: 'error', status: 401, errorType: 'authentication_error', message: 'invalid x-api-key' }

    case 'error-500':
      return { kind: 'error', status: 500, errorType: 'api_error', message: 'Internal server error' }

    case 'overloaded':
      return { kind: 'error', status: 529, errorType: 'overloaded_error', message: 'Overloaded' }

    default:
      return text(`(mock) roteiro desconhecido: ${script?.name}`)
  }
}
