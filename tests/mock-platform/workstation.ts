// The platform side of the computer workstation for the e2e: the employees the person manages
// (GET /api/employees?mine=1), turning one into an external worker (PUT /api/employees/{slug}/runtime → ewk_ token)
// and the worker hooks (heartbeat, gate with desktop:<action>, progress, result, AG-UI) with a scripted "brain":
// each AG-UI round answers with the next scripted events (a round may wait for the test before answering).
import type { IncomingMessage, ServerResponse } from 'node:http'

export type BrainRound = (body: { messages: unknown[]; tools: { name: string }[] }) => object[] | Promise<object[]>

export interface MockWorkerTask {
  id: number
  title: string
  status: 'new' | 'in_progress' | 'waiting_human' | 'done' | 'failed'
  messages: { role: string; content: string }[]
  decisions: { id: number; kind: string; status: string; decision: string; tool: string }[]
  rounds: BrainRound[]
  gates: { tool: string; args: Record<string, unknown>; screenshot: boolean }[]
  progress: Record<string, unknown>[]
  results: { status: string; result: string }[]
  runs: number
}

export interface MockRequestOpen {
  id: number
  taskId: number
  tool: string
  args: Record<string, unknown>
  screenshot: boolean
  status: 'open' | 'decided'
}

export interface MockWorkstation {
  employees: { slug: string; name: string; title: string; status: string; runtime: string; can_manage: boolean }[]
  token?: string
  runtimeCalls: { slug: string; runtime: string }[]
  tasks: Map<number, MockWorkerTask>
  requests: MockRequestOpen[]
  heartbeats: number
  worker?: Record<string, unknown>
  /** desktop:<action> → the gate's answer (default: allowed). */
  gate: (tool: string, args: Record<string, unknown>) => 'allowed' | 'waiting'
  /** The vault: secret://name → value (only the worker gets it, in the gate answer). */
  secrets: Record<string, string>
  addTask(t: { id: number; title: string; body: string; rounds: BrainRound[] }): MockWorkerTask
  /** Decides an open request: the task goes back to the queue with the decision. */
  decide(requestId: number, decision: 'approve' | 'reject'): void
  routes(req: IncomingMessage, res: ServerResponse, ctx: { path: string; appAuth(): boolean }): Promise<boolean>
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

const json = (res: ServerResponse, status: number, b: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(b))
  return true
}

export function mockWorkstation(): MockWorkstation {
  let seq = 900
  let eventSeq = 0
  const ws: MockWorkstation = {
    employees: [
      {
        slug: 'assistente-adm',
        name: 'Assistente Administrativo',
        title: 'Assistente',
        status: 'active',
        runtime: 'hangar',
        can_manage: true
      }
    ],
    runtimeCalls: [],
    tasks: new Map(),
    requests: [],
    heartbeats: 0,
    gate: () => 'allowed',
    secrets: {},
    addTask(t) {
      const task: MockWorkerTask = {
        id: t.id,
        title: t.title,
        status: 'new',
        messages: [{ role: 'user', content: t.body }],
        decisions: [],
        rounds: t.rounds,
        gates: [],
        progress: [],
        results: [],
        runs: 0
      }
      ws.tasks.set(t.id, task)
      return task
    },
    decide(id, decision) {
      const r = ws.requests.find((x) => x.id === id)
      if (!r) throw new Error(`pedido ${id} não existe`)
      r.status = 'decided'
      const t = ws.tasks.get(r.taskId)!
      t.decisions.push({
        id,
        kind: 'approval',
        status: decision === 'approve' ? 'approved' : 'rejected',
        decision,
        tool: r.tool
      })
      if (decision !== 'approve') t.messages.push({ role: 'user', content: `DECISÃO #${id}: RECUSADO. Não faça isso.` })
      t.status = 'new'
    },
    async routes(req, res, { path, appAuth }) {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && path === '/api/employees') {
        if (!appAuth()) return true
        if (url.searchParams.get('mine') !== '1') return json(res, 403, { detail: 'forbidden: só com mine=1' })
        return json(res, 200, ws.employees)
      }
      const rt = /^\/api\/employees\/([^/]+)\/runtime$/.exec(path)
      if (req.method === 'PUT' && rt) {
        if (!appAuth()) return true
        const b = await body(req)
        const e = ws.employees.find((x) => x.slug === decodeURIComponent(rt[1]))
        if (!e) return json(res, 404, { detail: 'funcionário não encontrado' })
        ws.runtimeCalls.push({ slug: e.slug, runtime: String(b.runtime) })
        e.runtime = String(b.runtime)
        if (b.runtime === 'external') {
          ws.token = `ewk_mock_${Date.now().toString(36)}`
          return json(res, 200, { runtime: 'external', token: ws.token })
        }
        ws.token = undefined
        return json(res, 200, { runtime: 'hangar' })
      }
      if (!path.startsWith('/hooks/worker/')) return false
      if (!ws.token || req.headers.authorization !== `Bearer ${ws.token}`)
        return json(res, 401, { detail: 'token do worker inválido' })
      const b = await body(req)
      if (path === '/hooks/worker/heartbeat') {
        ws.heartbeats++
        if (b.worker) ws.worker = b.worker as Record<string, unknown>
        const t = b.want_task === false ? undefined : [...ws.tasks.values()].find((x) => x.status === 'new')
        if (!t)
          return json(res, 200, {
            employee: 'assistente-adm',
            name: 'Assistente',
            status: 'active',
            task: null,
            next_heartbeat_s: 1
          })
        t.status = 'in_progress'
        t.runs++
        return json(res, 200, {
          employee: 'assistente-adm',
          name: 'Assistente',
          status: 'active',
          next_heartbeat_s: 1,
          task: {
            id: t.id,
            title: t.title,
            body: '',
            run: t.runs,
            url: `http://mock/app/#/tasks/${t.id}`,
            messages: t.messages,
            decisions: t.decisions,
            budget_usd: 1,
            cost_usd: 0,
            time_limit_min: 30
          }
        })
      }
      const m = /^\/hooks\/worker\/tasks\/(\d+)\/(gate|progress|result|agui)$/.exec(path)
      const t = m ? ws.tasks.get(Number(m[1])) : undefined
      if (!m || !t) return json(res, 404, { detail: 'Not Found' })
      if (t.status !== 'in_progress') return json(res, 409, { detail: `a tarefa #${t.id} não está com o worker` })
      if (m[2] === 'gate') {
        const tool = String(b.tool)
        const args = (b.args ?? {}) as Record<string, unknown>
        t.gates.push({ tool, args, screenshot: !!b.screenshot })
        const approved = t.decisions.find(
          (d) => d.decision === 'approve' && d.tool === tool && !d.status.endsWith('used')
        )
        if (approved) {
          approved.status = 'approved-used'
          // like the platform: the click runs where the person approved
          const asked = ws.requests.find((r) => r.id === approved.id)?.args
          const where = asked && typeof asked.x === 'number' ? { where: { x: asked.x, y: asked.y } } : {}
          return json(res, 200, { status: 'allowed', approved: approved.id, event: ++eventSeq, ...where })
        }
        if (ws.gate(tool, args) === 'waiting') {
          const id = ++seq
          ws.requests.push({ id, taskId: t.id, tool, args, screenshot: !!b.screenshot, status: 'open' })
          t.status = 'waiting_human'
          return json(res, 200, { status: 'waiting', request_id: id, action_type: 'write_internal' })
        }
        const ref = typeof args.text === 'string' && args.text.startsWith('secret://') ? args.text.slice(9) : undefined
        if (tool === 'desktop:type' && ref !== undefined) {
          if (!(ref in ws.secrets)) return json(res, 409, { detail: `segredo '${ref}' não existe no cofre` })
          return json(res, 200, { status: 'allowed', event: ++eventSeq, text: ws.secrets[ref], secret: true })
        }
        return json(res, 200, { status: 'allowed', event: ++eventSeq })
      }
      if (m[2] === 'progress') {
        t.progress.push(b)
        return json(res, 200, { status: t.status, cost_usd: 0, stop: false })
      }
      if (m[2] === 'result') {
        t.results.push({ status: String(b.status), result: typeof b.result === 'string' ? b.result : '' })
        t.status = b.status === 'done' ? 'done' : b.status === 'failed' ? 'failed' : 'new'
        if (b.status === 'waiting' && ws.requests.some((r) => r.taskId === t.id && r.status === 'open'))
          t.status = 'waiting_human'
        return json(res, 200, { id: t.id, status: t.status })
      }
      // agui: the next scripted round, as SSE, then hangar.task
      const round = t.rounds.shift()
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events = round ? await round(b as never) : [{ type: 'TEXT_MESSAGE_CONTENT', delta: 'Fim.' }]
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'CUSTOM', name: 'hangar.task', value: { status: t.status } })}\n\n`)
      res.end()
      return true
    }
  }
  return ws
}

export const call = (id: string, name: string, args: object): object[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) },
  { type: 'TOOL_CALL_END', toolCallId: id }
]
export const say = (text: string): object[] => [{ type: 'TEXT_MESSAGE_CONTENT', delta: text }]
