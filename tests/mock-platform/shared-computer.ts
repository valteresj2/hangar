// The platform side of a shared computer for the e2e: registering this computer (/api/app/workstations), its hooks
// (/hooks/workstation/*: heartbeat with the loan requests, the loan in use and the next step; the step results; the
// person's answer; Stop) and helpers for the test to ask for a loan and queue screen steps.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LeaseInfo } from '../../src/shared/features/computer'

export interface MockStep {
  id: number
  command: 'open' | 'look' | 'click' | 'type_text' | 'key' | 'scroll'
  args: Record<string, unknown>
}

export interface MockSharedComputer {
  registered?: { id: number; body: Record<string, unknown>; token: string }
  patches: Record<string, unknown>[]
  deleted: boolean
  requests: LeaseInfo[]
  active: LeaseInfo | null
  steps: MockStep[]
  results: Map<number, Record<string, unknown>>
  answers: { lease: number; allow: boolean }[]
  stops: number[]
  beats: number
  /** An employee asks for this computer (ask mode: the person answers). */
  ask(l: Partial<LeaseInfo> & { lease_id: number }): void
  /** A screen step already cleared by the authority, for the loan in use. */
  step(command: MockStep['command'], args: Record<string, unknown>): number
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

export function mockSharedComputer(): MockSharedComputer {
  let stepSeq = 0
  const m: MockSharedComputer = {
    patches: [],
    deleted: false,
    requests: [],
    active: null,
    steps: [],
    results: new Map(),
    answers: [],
    stops: [],
    beats: 0,
    ask(l) {
      m.requests.push({
        request_id: 1000 + l.lease_id,
        employee: 'Engenheiro de Dados',
        employee_slug: 'engenheiro-de-dados',
        task_id: 1530,
        task_title: 'Baixa da fatura 88 no ERP',
        app: 'Bloco de Notas',
        reason: 'registrar a baixa',
        status: 'requested',
        ...l
      })
    },
    step(command, args) {
      const id = ++stepSeq
      m.steps.push({ id, command, args })
      return id
    },
    async routes(req, res, { path, appAuth }) {
      if (path === '/api/app/workstations' && req.method === 'POST') {
        if (!appAuth()) return true
        const b = await body(req)
        m.registered = { id: 41, body: b, token: `wst_mock_${Date.now().toString(36)}` }
        return json(res, 200, {
          id: 41,
          name: String(b.name),
          os: typeof b.os === 'string' ? b.os : '',
          apps: b.apps,
          online: false,
          busy: false,
          auth_mode: b.auth_mode,
          allow_managed: b.allow_managed,
          allow_team_ids: b.allow_team_ids ?? [],
          token: m.registered.token
        })
      }
      const one = /^\/api\/app\/workstations\/(\d+)$/.exec(path)
      if (one) {
        if (!appAuth()) return true
        if (req.method === 'PATCH') {
          m.patches.push(await body(req))
          return json(res, 200, { id: 41 })
        }
        if (req.method === 'DELETE') {
          m.deleted = true
          m.registered = undefined
          return json(res, 200, { id: 41, status: 'off' })
        }
      }
      if (!path.startsWith('/hooks/workstation/')) return false
      if (!m.registered || req.headers.authorization !== `Bearer ${m.registered.token}`)
        return json(res, 401, { detail: 'token do computador inválido' })
      const b = await body(req)
      if (path === '/hooks/workstation/heartbeat') {
        m.beats++
        const step = m.active ? (m.steps.shift() ?? null) : null
        return json(res, 200, {
          workstation: { id: 41, name: 'Computador', online: true },
          requests: m.requests,
          active: m.active,
          step,
          next_s: 0
        })
      }
      const r = /^\/hooks\/workstation\/steps\/(\d+)\/result$/.exec(path)
      if (r) {
        m.results.set(Number(r[1]), (b.result ?? {}) as Record<string, unknown>)
        return json(res, 200, { ok: true })
      }
      const a = /^\/hooks\/workstation\/leases\/(\d+)\/(answer|stop)$/.exec(path)
      if (a && a[2] === 'answer') {
        const id = Number(a[1])
        const l = m.requests.find((x) => x.lease_id === id)
        if (!l) return json(res, 409, { detail: 'pedido de empréstimo não está mais aberto' })
        m.requests = m.requests.filter((x) => x.lease_id !== id)
        m.answers.push({ lease: id, allow: b.allow === true })
        if (b.allow === true) m.active = { ...l, status: 'active' }
        return json(res, 200, { lease: l })
      }
      if (a && a[2] === 'stop') {
        m.stops.push(Number(a[1]))
        m.active = null
        return json(res, 200, { lease_id: Number(a[1]), status: 'ended' })
      }
      return json(res, 404, { detail: 'Not Found' })
    }
  }
  return m
}
