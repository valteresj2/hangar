// The worker's conversation with the employee's brain over AG-UI (POST /hooks/worker/tasks/{id}/agui) and the HTTP
// client of the worker hooks. Ported from the VS Code workstation (central_agents extensions/vscode/src/core.ts), plus
// screenshots: AG-UI tool messages are text-only in the agent runtime, so the captures of a step go in one user message
// with `binary` image parts after the tool results, with the runtime's own marker so it keeps only the latest ones.
// Pure (no Electron): unit-tested in tests/unit/computer.test.ts.

/** A JSON value as text: strings as they are, numbers and booleans printed, anything else empty. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

export class HangarError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

export interface TextPart {
  type: 'text'
  text: string
}
export interface ImagePart {
  type: 'binary'
  mimeType: string
  data: string
}

export interface AguiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content?: string | (TextPart | ImagePart)[]
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  toolCallId?: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: object
}

export interface WorkerTask {
  id: number
  title: string
  body: string
  run: number
  url: string
  language?: string
  messages: { role: string; content: string }[]
  decisions: { id: number; kind: string; status: string; decision: string; tool: string }[]
  budget_usd: number
  cost_usd: number
  time_limit_min: number
}

export interface GateResult {
  status: 'allowed' | 'waiting' | 'denied' | 'simulated'
  message?: string
  request_id?: number
  action_type?: string
  /** desktop:click — where the person approved (image coordinates of the capture they saw). */
  where?: { x?: number; y?: number; element?: string }
  approved?: number | null
  covered_by?: number | null
  /** The timeline event of this action (sent back in progress with the window after it). */
  event?: number
  /** desktop:type — the real text to type (a secret:// value, or data the platform masked): never shown or saved. */
  text?: string
  secret?: boolean
  /** desktop:screenshot — the evidence file stored in the task. */
  file?: string
}

export type AguiEvent =
  | { type: 'text'; text: string }
  | { type: 'server_tool'; id: string; name: string }
  | { type: 'client_call'; id: string; name: string; input: Record<string, unknown>; raw: string }
  | { type: 'usage'; value: Record<string, number> }
  | { type: 'task'; value: { status: string; cost_usd?: number; request?: number | null } }
  | { type: 'error'; message: string }

/** The runtime's marker for tool images (runtime/app.py `_prune_images` keeps only the latest messages with it). */
export const IMAGE_MARKER = 'Imagens devolvidas pelas ferramentas nesta etapa'

/** Reads the AG-UI stream. A tool call without TOOL_CALL_RESULT is ours (the runtime ran its own), emitted at the end. */
export async function* parseAgui(
  chunks: AsyncIterable<string>,
  clientNames: ReadonlySet<string>
): AsyncGenerator<AguiEvent> {
  let buf = ''
  const calls = new Map<string, { name: string; args: string }>()
  const answered = new Set<string>()
  const handle = function* (ev: Record<string, unknown>): Generator<AguiEvent> {
    const t = ev.type
    if (t === 'TEXT_MESSAGE_CONTENT' && typeof ev.delta === 'string') yield { type: 'text', text: ev.delta }
    else if (t === 'TOOL_CALL_START') calls.set(str(ev.toolCallId), { name: str(ev.toolCallName), args: '' })
    else if (t === 'TOOL_CALL_ARGS') {
      const c = calls.get(str(ev.toolCallId))
      if (c) c.args += str(ev.delta)
    } else if (t === 'TOOL_CALL_RESULT') {
      answered.add(str(ev.toolCallId))
      yield { type: 'server_tool', id: str(ev.toolCallId), name: calls.get(str(ev.toolCallId))?.name ?? '' }
    } else if (t === 'RUN_ERROR') yield { type: 'error', message: str(ev.message) || 'erro no agente' }
    else if (t === 'CUSTOM' && ev.name === 'hangar.usage')
      yield { type: 'usage', value: (ev.value ?? {}) as Record<string, number> }
    else if (t === 'CUSTOM' && ev.name === 'hangar.task') yield { type: 'task', value: ev.value as { status: string } }
  }
  for await (const chunk of chunks) {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data: {')) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line.slice(6)) as Record<string, unknown>
      } catch {
        continue
      }
      yield* handle(ev)
    }
  }
  for (const [id, c] of calls) {
    if (answered.has(id) || !clientNames.has(c.name)) continue
    let input: Record<string, unknown>
    try {
      input = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {}
    } catch {
      input = { _raw: c.args }
    }
    yield { type: 'client_call', id, name: c.name, input, raw: c.args || '{}' }
  }
}

/** The task conversation (OpenAI format, from the heartbeat) → AG-UI messages. */
export function toAguiMessages(messages: { role: string; content: string }[]): AguiMessage[] {
  return messages
    .filter((m) => ['user', 'assistant', 'system'].includes(m.role))
    .map((m, i) => ({ id: `h${i}`, role: m.role as AguiMessage['role'], content: String(m.content ?? '') }))
}

/** One user message with the captures of a step (the model looks at them; the runtime prunes the older ones). */
export function imagesMessage(id: string, pngs: string[]): AguiMessage {
  return {
    id,
    role: 'user',
    content: [
      { type: 'text', text: `${IMAGE_MARKER} (${pngs.length}), para você conferir visualmente:` },
      ...pngs.map((data) => ({ type: 'binary' as const, mimeType: 'image/png', data }))
    ]
  }
}

const isImagesMessage = (m: AguiMessage): boolean =>
  m.role === 'user' &&
  Array.isArray(m.content) &&
  m.content.some((p) => p.type === 'binary') &&
  m.content[0]?.type === 'text' &&
  m.content[0].text.startsWith(IMAGE_MARKER)

/** Keeps only the latest `keep` screenshot messages whole; older ones become a short note (the model acts on the current screen). */
export function pruneImages(messages: AguiMessage[], keep = 3): AguiMessage[] {
  let seen = 0
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    if (!isImagesMessage(out[i])) continue
    seen++
    if (seen > keep) out[i] = { ...out[i], content: '[capturas de tela anteriores omitidas]' }
  }
  return out
}

const sizeOf = (m: AguiMessage): number =>
  (typeof m.content === 'string'
    ? m.content.length
    : (m.content ?? []).reduce((n, p) => n + (p.type === 'text' ? p.text.length : 800), 0)) +
  JSON.stringify(m.toolCalls ?? '').length

/** Keeps the conversation within a size: older tool outputs become their start and end. */
export function compact(messages: AguiMessage[], maxChars = 180_000, keepRecent = 12): AguiMessage[] {
  const size = (ms: AguiMessage[]): number => ms.reduce((n, m) => n + sizeOf(m), 0)
  const out = pruneImages(messages).map((m) => ({ ...m }))
  if (size(out) <= maxChars) return out
  const tools = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
  for (const i of tools.slice(0, Math.max(0, tools.length - keepRecent))) {
    const content = out[i].content
    const c = typeof content === 'string' ? content : ''
    if (c.length > 800)
      out[i].content = `${c.slice(0, 400)}\n…[saída antiga resumida: ${c.length} caracteres]…\n${c.slice(-300)}`
    if (size(out) <= maxChars) break
  }
  return out
}

/** The result of an action that came back from a decision that did not allow it ("DECISÃO #n: …"); undefined = allowed. */
export function decisionResult(
  d: { id: number; decision: string } | undefined,
  arrived: { content: string }[]
): string | undefined {
  if (!d || !d.decision || d.decision.startsWith('approve')) return undefined
  const said = arrived.find((m) => m.content.startsWith(`DECISÃO #${d.id}:`))
  return (
    said?.content ??
    `DECISÃO #${d.id}: ${d.decision === 'instruct' ? 'INSTRUÇÃO' : 'RECUSADO'}. ` +
      'Não execute a ação como estava; siga sem ela ou explique na entrega.'
  )
}

/** Did the tool work? (from the text it returned to the agent) */
export function toolOk(content: string): boolean {
  return !/^(erro|NEGADO|NÃO |DECISÃO #\d+: (?:INSTRUÇÃO|RECUSADO))/.test(content)
}

export interface WorkerToolStep {
  name: string
  summary: string
  ok: boolean
  ms: number
}

type FetchLike = typeof fetch

/** Client of the worker hooks: the employee's token (ewk_…) only talks to its own tasks. */
export class WorkerClient {
  constructor(
    readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async req(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const r = await this.fetchImpl(this.base.replace(/\/$/, '') + path, {
      method: 'POST',
      signal,
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
    })
    if (!r.ok) {
      let msg = r.statusText
      try {
        const j = (await r.json()) as { detail?: string; error?: string }
        msg = j.detail ?? j.error ?? msg
      } catch {
        /* not JSON */
      }
      throw new HangarError(msg || `HTTP ${r.status}`, r.status)
    }
    return r
  }

  async heartbeat(
    worker: object,
    wantTask = true
  ): Promise<{ employee: string; name: string; status: string; task: WorkerTask | null; next_heartbeat_s: number }> {
    return (await (await this.req('/hooks/worker/heartbeat', { worker, want_task: wantTask })).json()) as {
      employee: string
      name: string
      status: string
      task: WorkerTask | null
      next_heartbeat_s: number
    }
  }

  async gate(taskId: number, tool: string, args: object, rationale = '', screenshot = ''): Promise<GateResult> {
    return (await (
      await this.req(`/hooks/worker/tasks/${taskId}/gate`, {
        tool,
        args,
        rationale,
        ...(screenshot ? { screenshot } : {})
      })
    ).json()) as GateResult
  }

  async progress(
    taskId: number,
    note = '',
    extra: { tool?: WorkerToolStep; desktop?: { event?: number; after?: string; ok?: boolean; error?: string } } = {}
  ): Promise<{ status: string; cost_usd: number; stop: boolean }> {
    return (await (await this.req(`/hooks/worker/tasks/${taskId}/progress`, { note, ...extra })).json()) as {
      status: string
      cost_usd: number
      stop: boolean
    }
  }

  async result(
    taskId: number,
    status: 'done' | 'failed' | 'waiting',
    result = '',
    error = ''
  ): Promise<{ status: string }> {
    return (await (await this.req(`/hooks/worker/tasks/${taskId}/result`, { status, result, error })).json()) as {
      status: string
    }
  }

  async *agui(
    taskId: number,
    body: object,
    clientNames: ReadonlySet<string>,
    signal?: AbortSignal
  ): AsyncGenerator<AguiEvent> {
    const r = await this.req(`/hooks/worker/tasks/${taskId}/agui`, body, signal)
    if (!r.body) throw new HangarError('resposta sem corpo')
    const decoder = new TextDecoder()
    const reader = r.body.getReader()
    async function* chunks(): AsyncGenerator<string> {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        yield decoder.decode(value, { stream: true })
      }
    }
    yield* parseAgui(chunks(), clientNames)
  }
}
