// The live workflow graph model (src/shared/flow.ts): lanes, rows, edges and statuses from a harness event stream.
import { describe, expect, it } from 'vitest'
import { FLOW_NODE_W, FlowGraph, type FlowEvent } from '../../src/shared/flow'

function build(events: FlowEvent[]): FlowGraph {
  const g = new FlowGraph()
  for (const ev of events) g.on(ev)
  return g
}

describe('flow graph', () => {
  it('a turn: user node, tool calls of one model turn side by side, a result node', () => {
    const g = build([
      { type: 'turn', text: 'corrija o bug do carrinho', model: 'openai/gpt-4o' },
      { type: 'llm_start', agent: 'work' },
      { type: 'tool_start', agent: 'work', id: 'a', name: 'read', args: { path: 'src\\cart\\total.js' } },
      { type: 'tool_start', agent: 'work', id: 'b', name: 'grep', args: { pattern: 'total' } },
      { type: 'tool_end', agent: 'work', id: 'a', ok: true, ms: 12 },
      { type: 'tool_end', agent: 'work', id: 'b', ok: false, ms: 1500, preview: 'invalid regex' },
      { type: 'llm_start', agent: 'work' },
      { type: 'tool_start', agent: 'work', id: 'c', name: 'shell', args: { command: 'npm test' } }
    ])
    let l = g.layout()
    expect(l.running).toBe(true)
    expect(l.nodes.map((n) => `${n.kind}:${n.title}`)).toEqual([
      'head:agente principal',
      'user:você',
      'tool:read',
      'tool:grep',
      'tool:shell'
    ])
    const [head, user, read, grep, shell] = l.nodes
    expect(head.sub).toBe('gpt-4o')
    expect(user.sub).toBe('corrija o bug do carrinho')
    expect(read.row).toBe(grep.row)
    expect(grep.x - read.x).toBeGreaterThanOrEqual(FLOW_NODE_W)
    expect(shell.row).toBe(read.row + 1)
    expect(read).toMatchObject({ sub: 'src/cart/total.js', status: 'ok', ms: 12 })
    expect(grep.status).toBe('err')
    expect(grep.tip).toContain('invalid regex')
    expect(shell.status).toBe('run')
    // head → user → read; fan-in of the parallel calls into the next row.
    expect(l.edges).toHaveLength(5)
    expect(l.toolCalls).toBe(3)
    expect(l.agents).toBe(1)

    g.on({ type: 'tool_end', agent: 'work', id: 'c', ok: true, ms: 900 })
    g.on({ type: 'turn_end', status: 'success', text: 'Corrigido: o total agora soma o frete.' })
    l = g.layout()
    expect(l.running).toBe(false)
    expect(l.nodes.at(-1)).toMatchObject({ kind: 'final', title: 'resultado', status: 'ok' })
    expect(l.nodes.at(-1)?.y).toBeGreaterThan(shell.y)
  })

  it('a sub-agent gets its own lane, linked from the task call that started it', () => {
    const l = build([
      { type: 'turn', text: 'revise' },
      {
        type: 'tool_start',
        agent: 'work',
        id: 't1',
        name: 'task',
        args: { prompt: 'revise o diff', agent: 'revisor' }
      },
      { type: 'tool_start', agent: 'sub1', id: 's1', name: 'read', args: { path: 'a.py' } },
      { type: 'tool_end', agent: 'sub1', id: 's1', ok: true, ms: 3 },
      { type: 'tool_end', agent: 'work', id: 't1', ok: true, ms: 4000 }
    ]).layout()
    expect(l.agents).toBe(2)
    expect(l.lanes[1].x).toBeGreaterThan(l.lanes[0].x + l.lanes[0].width)
    const sub = l.nodes.find((n) => n.title === 'sub-agente 1')!
    expect(sub.sub).toBe('contexto próprio')
    expect(sub.x).toBe(l.lanes[1].x)
    expect(l.edges.filter((e) => e.cross).map((e) => e.label)).toEqual(['delega'])
  })

  it('approvals, questions, project rules and an interrupted turn', () => {
    const g = build([
      { type: 'turn', text: 'rode' },
      { type: 'tool_start', agent: 'work', id: 'x', name: 'shell', args: { command: 'rm -r build' } },
      { type: 'permission', qid: 'p1', tool: 'shell', title: 'Run command?\nrm -r build' },
      { type: 'permission_result', qid: 'p1', decision: 'deny' },
      { type: 'tool_end', agent: 'work', id: 'x', ok: false, preview: 'not approved' },
      { type: 'question', qid: 'q1', question: 'Qual porta?' },
      { type: 'question', qid: 'q2', kind: 'approval', question: 'ignorada' },
      { type: 'answer', qid: 'q1', answer: '8080' },
      { type: 'hook', event: 'pre_finish', action: 'push', message: 'rode os testes antes' },
      { type: 'hook', event: 'pre_tool', action: 'allow', message: 'ok' },
      { type: 'tool_start', agent: 'work', id: 'y', name: 'shell', args: { command: 'npm test' } },
      { type: 'turn_end', status: 'interrupted' }
    ])
    const nodes = g.layout().nodes
    const titles = nodes.map((n) => n.title)
    expect(titles).toEqual([
      'agente principal',
      'você',
      'shell',
      'aprovação',
      'pergunta',
      'regra: ainda não',
      'shell',
      'interrompido'
    ])
    expect(nodes[3]).toMatchObject({ kind: 'ask', status: 'err', sub: '→ negado' })
    expect(nodes[4]).toMatchObject({ status: 'ok', sub: '→ 8080' })
    expect(nodes[6].status).toBe('stop') // was still running when the turn was interrupted
    expect(nodes[7].status).toBe('stop')
  })

  it('ignores events it does not draw, and counts changes', () => {
    const g = new FlowGraph()
    g.on({ type: 'delta', text: 'x' })
    g.on({ type: 'llm_end' })
    expect(g.version).toBe(0)
    expect(g.layout().nodes).toEqual([])
    g.on({ type: 'turn', text: 'oi' })
    expect(g.version).toBe(1)
    expect(g.layout().width).toBeGreaterThanOrEqual(300)
  })
})
