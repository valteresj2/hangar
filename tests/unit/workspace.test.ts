// Workspace (docs/platform/m1-contract.md): parsing of the member routes and of the platform's events
// (src/main/features/workspace/parse.ts), the SSE parser and the self-healing event stream (sse.ts), and the
// `hangar://open/<route>` deep links with their closed list of routes (src/shared/features/workspace.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseAgentDetail,
  parseChart,
  parseDecisions,
  parseEvent,
  parseFollowedTask,
  resultLinks,
  parseHome,
  parseInbox,
  parseInboxItems,
  taskIdFromToolResult,
  toDecide
} from '../../src/main/features/workspace/parse'
import {
  backoffDelay,
  BACKOFF_MAX_MS,
  EventStream,
  IDLE_MS,
  POLL_MS,
  SseParser,
  UNSUPPORTED_RETRY_MS,
  type SseMessage,
  type StreamStatus
} from '../../src/main/features/workspace/sse'
import { parseDeepLink, portalHash, validPortalTarget } from '../../src/shared/features/workspace'
import { mockChart, mockDecisions, mockWorkspace } from '../mock-platform/workspace'

describe('member routes', () => {
  it('parses /api/me/workspace', () => {
    const h = parseHome(mockWorkspace())
    expect(h).toMatchObject({
      workspace: 'Acme Ltda',
      llmReady: true,
      toDecide: 1,
      monthCostUsd: 12.34,
      personalAllowed: true,
      personalCount: 1,
      personalMax: 3,
      personalCapUsd: 50
    })
    expect(h.agents.map((a) => [a.slug, a.status, a.personal])).toEqual([
      ['analista-dados', 'active', true],
      ['suporte-n1', 'probation', false]
    ])
    expect(h.agents[0]).toMatchObject({
      title: 'Analista de BI',
      autonomyLevel: 'pleno',
      openDecisions: 1,
      cost30dUsd: 4.5,
      workingOn: { id: 501, title: 'Relatório de vendas de outubro' },
      hiredAt: '2026-09-01T12:00:00+00:00'
    })
    // `team` is the team's id on employees: not a name to show.
    expect(h.agents[0].team).toBeUndefined()
    expect(h.agents[1].workingOn).toBeUndefined()
    expect(h.builtAgents[0]).toMatchObject({
      slug: 'resumo-diario',
      status: 'production',
      version: 3,
      why: 'creator',
      schedules: 1,
      nextRunAt: '2026-10-26T09:00:00+00:00',
      cost30dUsd: 0.42
    })
    expect(h.myTasks.map((t) => t.id)).toEqual([501, 498])
  })

  it('reads timestamps without an offset as UTC (my_tasks[].created_at)', () => {
    const h = parseHome({
      my_tasks: [{ id: 3, title: 'Teste 2', status: 'draft', created_at: '2026-10-25T16:43:39.057317' }]
    })
    expect(h.myTasks[0].createdAt).toBe('2026-10-25T16:43:39.057317Z')
    expect(Date.parse(h.myTasks[0].createdAt!)).toBe(Date.UTC(2026, 9, 25, 16, 43, 39, 57))
  })

  it('survives garbage and drops entries it cannot identify', () => {
    expect(parseHome(undefined)).toMatchObject({ agents: [], builtAgents: [], myTasks: [], llmReady: true })
    expect(parseHome({})).toMatchObject({ workspace: '', toDecide: 0, monthCostUsd: 0 })
    const h = parseHome({
      to_decide: -3,
      month_cost_usd: 'muito',
      agents: [null, { name: 'sem slug' }, { slug: '../../etc', name: 'x' }, { slug: 'ok', status: 7 }],
      built_agents: 'nope',
      my_tasks: [{ id: 'abc' }, { id: 3, title: 'ok', created_at: 'ontem' }]
    })
    expect(h.toDecide).toBe(0)
    expect(h.monthCostUsd).toBe(0)
    expect(h.agents.map((a) => a.slug)).toEqual(['ok'])
    expect(h.agents[0]).toMatchObject({ name: 'ok', status: '7' })
    expect(h.builtAgents).toEqual([])
    expect(h.myTasks).toEqual([{ id: 3, title: 'ok', status: '', createdAt: undefined }])
  })

  it('parses /api/decisions; notices do not count as "para você decidir"', () => {
    const ds = parseDecisions(mockDecisions())
    expect(ds.map((d) => [d.id, d.kind, d.mine])).toEqual([
      [77, 'approval', true],
      [78, 'notice', false]
    ])
    expect(ds[0]).toMatchObject({
      employee: 'analista-dados',
      employeeName: 'Analista de Dados',
      question: 'Enviar o relatório para a diretoria?',
      taskTitle: 'Relatório de vendas de outubro'
    })
    expect(toDecide(ds).map((d) => d.id)).toEqual([77])
    // Without a question nor a task, the tool names it.
    expect(parseDecisions([{ id: 5, kind: 'approval', tool: 'send_email', task: null }])[0].taskTitle).toBe(
      'send_email'
    )
    expect(parseDecisions({ items: mockDecisions() })).toHaveLength(2)
    expect(parseDecisions('x')).toEqual([])
    expect(parseDecisions([{ id: 0 }, { kind: 'approval' }])).toEqual([])
  })

  it('parses what a decision card shows: rationale, risk, the action and its approvals', () => {
    const [d] = parseDecisions([
      {
        id: 9,
        kind: 'approval',
        tool: 'send_email',
        payload: { to: 'diretoria@acme.com' },
        rationale: 'O relatório está pronto.',
        risk: 'high',
        mode: 'approve_2',
        approvals: [{ by: 'Ana' }],
        task: { id: 31, title: 'Relatório' }
      }
    ])
    expect(d).toMatchObject({
      rationale: 'O relatório está pronto.',
      risk: 'high',
      tool: 'send_email',
      taskId: 31,
      approvals: 1,
      approvalsNeeded: 2
    })
    expect(d.payload).toContain('"to": "diretoria@acme.com"')
    expect(parseDecisions([{ id: 3, kind: 'question', payload: {} }])[0]).toMatchObject({
      payload: undefined,
      approvals: 0,
      approvalsNeeded: 1
    })
  })

  it('parses the inbox items and an agent detail (bad keys and odd fields dropped)', () => {
    const items = parseInboxItems({
      items: [
        { key: 'decision:12', kind: 'decision', title: 'Enviar?', unread: true, employee: 'analista-dados' },
        { key: 'task:7', kind: 'task', title: 'Relatório', task_id: 7, status: 'done', requested: true },
        { key: 'sem dois pontos', title: 'x' },
        { key: 'decision:1 drop', title: 'x' }
      ]
    })
    expect(items.map((i) => [i.key, i.decisionId, i.taskId, i.unread, i.requested])).toEqual([
      ['decision:12', 12, undefined, true, false],
      ['task:7', undefined, 7, false, true]
    ])
    const a = parseAgentDetail({
      slug: 'resumo-diario',
      name: 'Resumo diário',
      kind: 'single',
      status: 'prod',
      version: 3,
      stage: null,
      prod: { version: 3 },
      cost_7d: 0.42,
      requests_7d: 12,
      permissions: ['view', 'edit', 'manage', 7],
      versions: [
        { version: 2, created_by: 'ana', created_at: '2026-10-01T10:00:00' },
        { version: 3, created_by: 'ana' },
        { version: 'x' }
      ],
      last_test: { version: 3, status: 'passed', summary: '10/10' }
    })
    expect(a).toMatchObject({
      slug: 'resumo-diario',
      stageVersion: undefined,
      prodVersion: 3,
      cost7d: 0.42,
      requests7d: 12,
      permissions: ['view', 'edit', 'manage'],
      lastTest: { version: 3, status: 'passed', summary: '10/10' }
    })
    expect(a?.versions.map((v) => v.version)).toEqual([3, 2])
    expect(parseAgentDetail({ slug: '../x' })).toBeUndefined()
  })

  it('parses /api/org-chart?mine=1 and /api/inbox', () => {
    const c = parseChart(mockChart())
    expect(c.nodes[0]).toMatchObject({
      slug: 'analista-dados',
      level: 'pleno',
      model: 'claude-sonnet-4-5',
      harness: 'claude-code',
      specialists: ['SQL Helper'],
      personal: true,
      workingOn: { id: 501 }
    })
    expect(parseChart({ nodes: 'x' })).toEqual({ nodes: [] })
    expect(parseInbox({ view: 'unread', counts: { all: 5, unread: 2, decisions: 1, blocked: 0 } })).toEqual({
      all: 5,
      unread: 2,
      decisions: 1,
      blocked: 0
    })
    expect(parseInbox(null)).toEqual({ all: 0, unread: 0, decisions: 0, blocked: 0 })
  })
})

describe('platform events', () => {
  it('accepts the M1 types', () => {
    expect(parseEvent('inbox.changed', '{"unread":4}')).toEqual({ type: 'inbox.changed', unread: 4 })
    expect(parseEvent('decision.created', '{"id":9,"title":"Aprovar envio","agent":"Analista"}')).toEqual({
      type: 'decision.created',
      id: 9,
      title: 'Aprovar envio',
      agent: 'Analista'
    })
    expect(parseEvent('decision.decided', '{"id":"9"}')).toEqual({ type: 'decision.decided', id: 9 })
    expect(parseEvent('agent.status', '{"slug":"suporte-n1","status":"paused"}')).toEqual({
      type: 'agent.status',
      slug: 'suporte-n1',
      status: 'paused'
    })
    expect(parseEvent('models.changed', '{"version":"v8"}')).toEqual({ type: 'models.changed', version: 'v8' })
  })

  it('ignores unknown types and bad payloads', () => {
    expect(parseEvent('message', '{}')).toBeUndefined()
    expect(parseEvent('task.status', '{"id":1}')).toBeUndefined()
    expect(parseEvent('inbox.changed', 'not json')).toBeUndefined()
    expect(parseEvent('inbox.changed', '{"unread":"4"}')).toBeUndefined()
    expect(parseEvent('inbox.changed', '[1]')).toBeUndefined()
    expect(parseEvent('decision.created', '{"title":"sem id"}')).toBeUndefined()
    expect(parseEvent('decision.decided', '{"id":-1}')).toBeUndefined()
    expect(parseEvent('agent.status', '{"slug":"A B","status":"x"}')).toBeUndefined()
    expect(parseEvent('agent.status', '{"slug":"ok"}')).toBeUndefined()
  })
})

describe('SseParser', () => {
  it('parses events, ids and multi-line data across arbitrary chunk boundaries', () => {
    const text =
      ': conectado\n\nid: 1\nevent: inbox.changed\ndata: {"unread":1}\n\n' +
      'id: 2\r\nevent: decision.created\r\ndata: {"id":5,\r\ndata: "title":"x"}\r\n\r\n' +
      ': keepalive\n\nevent: x\nid: 3\n\ndata:sem espaço\n\n'
    // Every split point gives the same result.
    for (let cut = 0; cut <= text.length; cut++) {
      const p = new SseParser()
      const out = [...p.feed(text.slice(0, cut)), ...p.feed(text.slice(cut))]
      expect(out).toEqual([
        { id: '1', event: 'inbox.changed', data: '{"unread":1}' },
        { id: '2', event: 'decision.created', data: '{"id":5,\n"title":"x"}' },
        { event: 'message', data: 'sem espaço' }
      ])
      // The id-only block (no data) dispatches nothing but still moves the last event id.
      expect(p.lastEventId).toBe('3')
    }
  })

  it('handles a lone \\r line ending split from its \\n', () => {
    const p = new SseParser()
    expect(p.feed('data: a\r')).toEqual([])
    expect(p.feed('\n\r')).toEqual([])
    expect(p.feed('\n')).toEqual([{ event: 'message', data: 'a' }])
  })
})

/** A controllable stream body: push text, end it, or fail it. */
function body() {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) })
  return {
    stream,
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => ctl.close()
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('EventStream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(open: (lastId: string | undefined) => Promise<ReadableStream<Uint8Array> | null>) {
    const statuses: StreamStatus[] = []
    const messages: SseMessage[] = []
    const calls: (string | undefined)[] = []
    const polls = vi.fn()
    const reconnected = vi.fn()
    const s = new EventStream({
      open: (lastId) => {
        calls.push(lastId)
        return open(lastId)
      },
      onMessage: (m) => messages.push(m),
      onStatus: (x) => statuses.push(x),
      poll: polls,
      onReconnected: reconnected,
      unsupported: (err) => err instanceof Error && err.message === '404',
      random: () => 0.5
    })
    return { s, statuses, messages, calls, polls, reconnected }
  }

  it('goes live, delivers events, and resumes with Last-Event-ID when the platform closes the stream', async () => {
    const bodies = [body(), body()]
    let n = 0
    const t = setup(async () => bodies[n++].stream)
    t.s.start()
    await flush()
    expect(t.statuses).toEqual(['connecting', 'live'])
    bodies[0].push('retry: 5000\n\nid: 41\nevent: inbox.changed\ndata: {"unread":3}\n\n')
    await flush()
    expect(t.messages).toEqual([{ id: '41', event: 'inbox.changed', data: '{"unread":3}' }])

    // A clean close (the platform ends streams after 30 min): no polling, a quiet reconnection with the last id.
    bodies[0].end()
    await flush()
    expect(t.statuses.at(-1)).toBe('live')
    expect(t.calls).toEqual([undefined])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.calls).toEqual([undefined, '41'])
    expect(t.reconnected).not.toHaveBeenCalled()
    expect(t.polls).not.toHaveBeenCalled()
    t.s.stop()
  })

  it('a dropped connection switches to polling; back live, it asks for a refresh', async () => {
    let fail = false
    const bodies = [body(), body()]
    let n = 0
    const t = setup(async () => {
      if (fail) throw new Error('network')
      return bodies[n++].stream
    })
    t.s.start()
    await flush()
    bodies[0].push('id: 7\nevent: inbox.changed\ndata: {"unread":1}\n\n')
    await flush()
    fail = true
    bodies[0].end()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.statuses.at(-1)).toBe('polling')
    fail = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.calls).toEqual([undefined, '7', '7'])
    expect(t.statuses.at(-1)).toBe('live')
    expect(t.reconnected).toHaveBeenCalledTimes(1)
    t.s.stop()
  })

  it('backs off exponentially while the platform is down, polling every 60 s', async () => {
    const t = setup(async () => {
      throw new Error('network')
    })
    t.s.start()
    await flush()
    expect(t.statuses).toEqual(['connecting', 'polling'])
    // Attempts at +1 s, +2 s, +4 s, +8 s… (random 0.5 → no jitter).
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(t.calls).toHaveLength(4)
    expect(t.polls).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(t.polls).toHaveBeenCalledTimes(1)
    t.s.stop()
    await vi.advanceTimersByTimeAsync(10 * POLL_MS)
    expect(t.polls).toHaveBeenCalledTimes(1)
  })

  it('retries rarely on a platform without the event stream (404)', async () => {
    const t = setup(async () => {
      throw new Error('404')
    })
    t.s.start()
    await flush()
    await vi.advanceTimersByTimeAsync(UNSUPPORTED_RETRY_MS - 1)
    expect(t.calls).toHaveLength(1)
    expect(t.polls).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.calls).toHaveLength(2)
    t.s.stop()
  })

  it('treats a silent stream as dead (no keepalive for IDLE_MS)', async () => {
    const bodies = [body(), body()]
    let n = 0
    const t = setup(async () => bodies[n++].stream)
    t.s.start()
    await flush()
    bodies[0].push(': keepalive\n\n')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(t.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.statuses.at(-1)).toBe('polling')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.calls).toHaveLength(2)
    t.s.stop()
  })

  it('backoff stays within 1 s and 60 s (±20 %)', () => {
    expect(backoffDelay(1, () => 0)).toBe(800)
    expect(backoffDelay(1, () => 1)).toBe(1_200)
    expect(backoffDelay(30, () => 0.5)).toBe(BACKOFF_MAX_MS)
  })
})

describe('deep links', () => {
  it('routes the closed list', () => {
    expect(parseDeepLink('hangar://open/workspace/home')).toEqual({ view: 'home' })
    expect(parseDeepLink('hangar://open/workspace')).toEqual({ view: 'home' })
    expect(parseDeepLink('hangar://open/workspace/agents')).toEqual({ view: 'agents' })
    expect(parseDeepLink('hangar://open/workspace/agents/')).toEqual({ view: 'agents' })
    expect(parseDeepLink('HANGAR://open/mine')).toEqual({ view: 'agents' })
    // Decisões and Caixa de entrada are native screens since M2.
    expect(parseDeepLink('hangar://open/decisions')).toEqual({ view: 'decisions' })
    expect(parseDeepLink('hangar://open/decisions/42')).toEqual({ view: 'decisions' })
    expect(parseDeepLink('hangar://open/decisions/abc')).toBeUndefined()
    expect(parseDeepLink('hangar://open/inbox')).toEqual({ view: 'inbox' })
    expect(parseDeepLink('hangar://open/tasks/501')).toEqual({ portal: { screen: 'task', id: 501 } })
    expect(parseDeepLink('hangar://open/agents/resumo-diario')).toEqual({
      portal: { screen: 'agent', slug: 'resumo-diario' }
    })
    expect(parseDeepLink('hangar://open/employees/analista-dados')).toEqual({
      portal: { screen: 'employee', slug: 'analista-dados' }
    })
  })

  it.each([
    '',
    'hangar://',
    'hangar://open',
    'hangar://open/',
    'hangar://evil/workspace/home',
    'https://open/workspace/home',
    'hangar:open/workspace/home',
    'hangar://open/workspace/settings',
    'hangar://open/workspace/home?x=1',
    'hangar://open/workspace/home#x',
    'hangar://open/workspace//home',
    'hangar://open/../workspace/home',
    'hangar://open/workspace/%2e%2e',
    'hangar://open/agents/../../etc',
    'hangar://open/agents/Maiusculo',
    'hangar://open/agents/a/b',
    'hangar://open/decisions/0',
    'hangar://open/decisions/abc',
    'hangar://open/decisions/1e3',
    'hangar://open/tasks',
    'hangar://open/inbox/1',
    'hangar://user:pw@open/workspace/home',
    'hangar://open:8080/workspace/home',
    'hangar://open/javascript:alert(1)',
    'hangar://open/https://evil.example',
    ' hangar://open/workspace/home\nhangar://open/inbox',
    `hangar://open/agents/${'a'.repeat(300)}`
  ])('refuses %j', (url) => {
    expect(parseDeepLink(url)).toBeUndefined()
  })

  it('refuses what is not a string', () => {
    expect(parseDeepLink(undefined)).toBeUndefined()
    expect(parseDeepLink({ toString: () => 'hangar://open/workspace/home' })).toBeUndefined()
  })

  it('maps portal targets to the portal hash routes, and checks targets from the renderer', () => {
    expect(portalHash({ screen: 'home' })).toBe('#/')
    expect(portalHash({ screen: 'decisions' })).toBe('#/decisions')
    expect(portalHash({ screen: 'decision', id: 4 })).toBe('#/decisions')
    expect(portalHash({ screen: 'task', id: 501 })).toBe('#/tasks/501')
    expect(portalHash({ screen: 'agent', slug: 'resumo-diario' })).toBe('#/agents/resumo-diario')
    expect(portalHash({ screen: 'employee', slug: 'analista-dados' })).toBe('#/employees/analista-dados')
    expect(portalHash({ screen: 'connect-ai' })).toBe('#/connect-ai')
    expect(validPortalTarget({ screen: 'inbox' })).toBe(true)
    expect(validPortalTarget({ screen: 'agent', slug: 'ok' })).toBe(true)
    expect(validPortalTarget({ screen: 'agent', slug: '../admin' })).toBe(false)
    expect(validPortalTarget({ screen: 'task', id: 1.5 })).toBe(false)
    expect(validPortalTarget({ screen: 'inbox', url: 'https://evil.example' })).toBe(false)
    expect(validPortalTarget({ screen: 'admin' })).toBe(false)
    expect(validPortalTarget('#/inbox')).toBe(false)
  })
})

describe('acompanhar uma tarefa na sessão', () => {
  it('pega o número da tarefa da resposta do assign_task (JSON ou texto)', () => {
    expect(taskIdFromToolResult('{"id": 1488, "title": "x", "status": "new"}')).toBe(1488)
    expect(taskIdFromToolResult('{"task": {"id": 77}}')).toBe(77)
    expect(taskIdFromToolResult('Tarefa nº 1486 criada para o engenheiro')).toBe(1486)
    expect(taskIdFromToolResult('nada aqui')).toBeUndefined()
  })

  it('transforma a tarefa da plataforma no cartão, com a linha do tempo em palavras', () => {
    const t = parseFollowedTask(
      {
        id: 1486,
        title: 'CNPJ: base',
        status: 'waiting_human',
        cost_usd: 6.44,
        tokens: 1200,
        plan: [{ title: 'Ingestão', status: 'done' }, { title: 'Features', status: 'doing' }, { title: '' }],
        progress: { done: 1, total: 2, pct: 50 },
        events: [
          { kind: 'created', payload: {}, at: '2026-11-02T13:00:00Z' },
          { kind: 'checkpoint', payload: { messages: 2 }, at: '2026-11-02T13:01:00Z' },
          {
            kind: 'human_request',
            payload: { id: 618, kind: 'question', question: 'Como seguir?' },
            at: '2026-11-02T13:02:00Z'
          },
          { kind: 'handoff', payload: { to: 'cientista-de-dados', task: 1487 }, at: '2026-11-02T13:03:00Z' }
        ],
        requests: [
          { id: 618, kind: 'question', status: 'open', question: 'O retrato 2024-10 tem defeito. Como seguir?' },
          { id: 581, kind: 'capability', status: 'decided', payload: { need: 'terminal' } }
        ],
        children: [{ id: 1487, title: 'Modelo', status: 'in_progress', employee_name: 'Cientista de Dados' }],
        parent: null
      },
      { sessionId: 's1', employeeName: 'Engenheiro de Dados', wake: true }
    )!
    expect(t.steps.map((s) => s.title)).toEqual(['Ingestão', 'Features'])
    expect(t.lines.map((l) => l.text)).toEqual([
      'Tarefa criada',
      'Pedido #618 (question): Como seguir?',
      'Repasse → cientista-de-dados (tarefa #1487)'
    ])
    expect(t.requests).toEqual([{ id: 618, kind: 'question', text: 'O retrato 2024-10 tem defeito. Como seguir?' }])
    expect(t.children).toEqual([
      { id: 1487, title: 'Modelo', status: 'in_progress', employee: '', employeeName: 'Cientista de Dados' }
    ])
    expect(t.costUsd).toBe(6.44)
  })

  it('lista os entregáveis (os do funcionário primeiro) e os links do resultado', () => {
    const t = parseFollowedTask(
      {
        id: 1487,
        title: 'Modelo',
        status: 'done',
        result:
          'Pronto. Repositório: https://github.com/valteresj2/cnpj-model. Relatório em ' +
          '[aqui](https://github.com/valteresj2/cnpj-model/blob/main/REPORT.md), de novo https://github.com/valteresj2/cnpj-model',
        files: [
          { id: 3, name: 'dados.csv', version: 1, kind: 'input', size: 900 },
          { id: 4, name: 'relatorio.md', version: 3, kind: 'output', size: 120 },
          { id: 0, name: 'sem-id.txt' },
          { id: 5, name: '', kind: 'output' }
        ]
      },
      { sessionId: 's1', employeeName: 'Cientista', wake: true }
    )!
    expect(t.files).toEqual([
      { id: 4, name: 'relatorio.md', version: 3, kind: 'output', size: 120 },
      { id: 3, name: 'dados.csv', version: 1, kind: 'input', size: 900 }
    ])
    expect(t.links).toEqual([
      'https://github.com/valteresj2/cnpj-model',
      'https://github.com/valteresj2/cnpj-model/blob/main/REPORT.md'
    ])
    expect(resultLinks(undefined)).toEqual([])
  })

  it('reconhece o evento task.updated', () => {
    expect(parseEvent('task.updated', '{"id": 12, "status": "done"}')).toEqual({
      type: 'task.updated',
      id: 12,
      status: 'done'
    })
    expect(parseEvent('task.updated', '{"status": "done"}')).toBeUndefined()
  })
})
