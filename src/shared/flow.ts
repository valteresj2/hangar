// The live workflow graph of a Hangar-engine session: built node by node from the harness's event stream.
// One lane per agent (the main agent, each sub-agent, each workflow stage); one row per model turn, so time flows
// downward and tool calls made in the same turn sit side by side. A TypeScript port of the harness dashboard's
// flow.js (resources/harness/hangar/flow.js), plus the app's own turn markers. Pure: no DOM, unit-tested.

/** A harness event (or one of the app's own: `turn`, `turn_end`), already slimmed by the main process. */
export interface FlowEvent {
  type: string
  agent?: string
  [key: string]: unknown
}

export type FlowNodeKind = 'head' | 'user' | 'tool' | 'ask' | 'verdict' | 'esc' | 'warn' | 'mark' | 'final'
export type FlowNodeStatus = 'run' | 'ok' | 'err' | 'stop'

export interface FlowNode {
  id: number
  kind: FlowNodeKind
  title: string
  sub: string
  status?: FlowNodeStatus
  /** Full text for the tooltip and the detail strip. */
  tip: string
  ms?: number
  row: number
  col: number
  x: number
  y: number
}

export interface FlowEdge {
  /** SVG path. */
  d: string
  cross: boolean
  label?: string
  labelX: number
  labelY: number
}

export interface FlowLane {
  x: number
  width: number
}

export interface FlowLayout {
  width: number
  height: number
  lanes: FlowLane[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  agents: number
  toolCalls: number
  steps: number
  running: boolean
}

export const FLOW_NODE_W = 172
export const FLOW_NODE_H = 38
const GX = 12
const GY = 24
const PAD = 20
const LANE_GAP = 44

interface Lane {
  key: string
  cols: number
  rows: Record<number, number>
  last: FlowNode[]
  prev: FlowNode[]
  newRow: boolean
  rowN: number
  x: number
  w: number
}

interface Edge {
  a: FlowNode
  b: FlowNode
  cross?: boolean
  label?: string
}

type NodeInit = Pick<FlowNode, 'kind' | 'title'> & Partial<Pick<FlowNode, 'sub' | 'status' | 'tip'>>

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return JSON.stringify(v) ?? ''
}

function clip(value: unknown, n: number): string {
  const s = str(value).replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function tail(value: unknown, n: number): string {
  const s = str(value)
  return s.length > n ? `…${s.slice(-(n - 1))}` : s
}

function summary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (a.path) return tail(str(a.path).replace(/\\/g, '/'), 25)
  if (Array.isArray(a.items)) {
    const done = (a.items as ({ status?: string } | null)[]).filter((i) => i?.status === 'done').length
    return `${a.items.length} itens · ${done} feitos`
  }
  if (a.action) return clip(`${str(a.action)}${a.id ? ` ${str(a.id)}` : ''}`, 25)
  const first = a.command ?? a.pattern ?? a.url ?? a.query ?? a.question ?? a.prompt ?? a.name ?? Object.values(a)[0]
  return clip(first, 25)
}

const MAIN = 'work'

export class FlowGraph {
  private lanes: Lane[] = []
  private laneBy = new Map<string, Lane>()
  private nodes: FlowNode[] = []
  private nodeLane = new Map<FlowNode, Lane>()
  private edges: Edge[] = []
  private row = 0
  private byTool = new Map<string, FlowNode>()
  private models = new Map<string, string>()
  private subs = new Map<string, string>()
  private pendingStage: { node: string; visit: number } | undefined
  private stageTouched = true
  private curStage: Lane | undefined
  private stageLast: FlowNode[] = []
  private lastRoute = ''
  private pendingTask: FlowNode[] = []
  private lastLane: Lane | undefined
  private questions = new Map<string, FlowNode>()
  private model = ''
  private running = false
  /** Bumped on every change: a cheap dependency for memoized layouts. */
  version = 0

  private addNode(L: Lane, init: NodeInit, ownRow = false): FlowNode {
    if (ownRow || L.newRow) {
      this.row++
      L.prev = L.last
      L.last = []
      L.rowN = 0
      L.newRow = false
    }
    const n: FlowNode = {
      sub: '',
      tip: init.title,
      ...init,
      id: this.nodes.length,
      row: this.row,
      col: L.rowN++,
      x: 0,
      y: 0
    }
    L.cols = Math.max(L.cols, L.rowN)
    L.rows[n.row] = L.rowN
    const prev = L.prev
    if (prev.length === 1 || n.col > 0) {
      if (prev.length) this.edges.push({ a: prev[Math.floor(prev.length / 2)], b: n })
    } else for (const p of prev) this.edges.push({ a: p, b: n }) // fan-in after parallel calls
    this.nodes.push(n)
    this.nodeLane.set(n, L)
    L.last.push(n)
    this.lastLane = L
    if (ownRow) L.newRow = true
    return n
  }

  private lane(agent: string): Lane {
    const existing = this.laneBy.get(agent)
    if (existing) return existing
    const L: Lane = { key: agent, cols: 1, rows: {}, last: [], prev: [], newRow: true, rowN: 0, x: 0, w: 0 }
    this.laneBy.set(agent, L)
    this.lanes.push(L)
    const isSub = /^sub\d+$/.test(agent)
    const st = this.pendingStage
    const isMain = agent === MAIN || agent === 'main'
    const title = isSub
      ? `sub-agente ${agent.slice(3)}`
      : st
        ? `${st.node}${st.visit > 1 ? ` #${st.visit}` : ''}`
        : isMain
          ? 'agente principal'
          : agent
    const model = (st && this.models.get(st.node)) || (isMain ? this.model : '')
    const head = this.addNode(
      L,
      {
        kind: 'head',
        title,
        sub: isSub ? (this.subs.get(agent) ?? 'contexto próprio') : (model.split('/').pop() ?? '')
      },
      true
    )
    if (isSub) {
      const parent = this.pendingTask.shift()
      if (parent) this.edges.push({ a: parent, b: head, cross: true, label: 'delega' })
    } else if (st) {
      for (const p of this.stageLast) this.edges.push({ a: p, b: head, cross: true, label: this.lastRoute })
      this.curStage = L
      this.stageTouched = true
    }
    return L
  }

  private anyLane(agent: string): Lane {
    return this.laneBy.get(agent) ?? this.curStage ?? this.lastLane ?? this.lane(MAIN)
  }

  on(ev: FlowEvent): void {
    const a = ev.agent || MAIN
    switch (ev.type) {
      case 'turn': {
        if (str(ev.model)) this.model = str(ev.model)
        this.running = true
        const text = str(ev.text)
        this.addNode(this.lane(MAIN), { kind: 'user', title: 'você', sub: clip(text, 25), tip: text || 'você' }, true)
        break
      }
      case 'turn_end': {
        const status = str(ev.status)
        this.running = false
        for (const n of this.nodes) if (n.status === 'run') n.status = 'stop'
        const text = str(ev.text) || str(ev.error)
        const title =
          status === 'success'
            ? 'resultado'
            : status === 'interrupted'
              ? 'interrompido'
              : status === 'incomplete'
                ? 'incompleto'
                : 'erro'
        this.addNode(
          this.lane(MAIN),
          {
            kind: 'final',
            title,
            sub: clip(text, 25),
            status: status === 'success' ? 'ok' : status === 'interrupted' ? 'stop' : 'err',
            tip: text || title
          },
          true
        )
        break
      }
      case 'subagent': {
        // Which model a sub-agent got, and why: the harness routes light and deep work to different models.
        const level = str(ev.level)
        const prefix = level === 'light' ? 'leve · ' : level === 'deep' ? 'profundo · ' : ''
        this.subs.set(a, prefix + (str(ev.model).split('/').pop() ?? ''))
        return
      }
      case 'graph':
        if (Array.isArray(ev.nodes))
          for (const n of ev.nodes as { id?: unknown; model?: unknown }[]) this.models.set(str(n.id), str(n.model))
        break
      case 'node_start': {
        const node = str(ev.node)
        const visit = Number(ev.visit) || 1
        this.pendingStage = { node, visit }
        this.stageTouched = false
        const L = this.laneBy.get(node)
        if (L) {
          // Loop back into a stage that already ran (e.g. after "revise").
          const m = this.addNode(L, { kind: 'mark', title: 'retomada', sub: `visita ${visit}` }, true)
          for (const p of this.stageLast) this.edges.push({ a: p, b: m, cross: true, label: this.lastRoute })
          this.curStage = L
          this.stageTouched = true
        }
        break
      }
      case 'node_end':
        if (!this.stageTouched) this.lane(str(ev.node))
        if (this.curStage) this.stageLast = this.curStage.last.slice()
        this.lastRoute = str(ev.route)
        break
      case 'llm_start': {
        const L = this.laneBy.get(a)
        if (L) L.newRow = true
        break
      }
      case 'tool_start': {
        const name = str(ev.name)
        const n = this.addNode(this.lane(a), {
          kind: 'tool',
          title: name,
          sub: summary(ev.args),
          status: 'run',
          tip: `${name} ${JSON.stringify(ev.args ?? {})}`
        })
        this.byTool.set(str(ev.id), n)
        if (name === 'task') this.pendingTask.push(n)
        break
      }
      case 'tool_end': {
        const n = this.byTool.get(str(ev.id))
        if (!n) return
        n.status = ev.ok === false ? 'err' : 'ok'
        if (typeof ev.ms === 'number') n.ms = ev.ms
        if (ev.ok === false && str(ev.preview)) n.tip += `\n${str(ev.preview)}`
        break
      }
      case 'permission': {
        const title = str(ev.title)
        this.questions.set(
          `p:${str(ev.qid)}`,
          this.addNode(
            this.anyLane(a),
            { kind: 'ask', title: 'aprovação', sub: clip(title, 25), status: 'run', tip: title },
            true
          )
        )
        break
      }
      case 'permission_result': {
        const n = this.questions.get(`p:${str(ev.qid)}`)
        if (!n) return
        const allowed = str(ev.decision).startsWith('allow')
        n.status = allowed ? 'ok' : 'err'
        n.sub = allowed ? (str(ev.decision) === 'allow_always' ? '→ permitido sempre' : '→ permitido') : '→ negado'
        n.tip += `\n${n.sub}`
        break
      }
      case 'question': {
        if (ev.kind === 'approval') return
        const q = str(ev.question)
        this.questions.set(
          str(ev.qid),
          this.addNode(
            this.anyLane(a),
            { kind: 'ask', title: 'pergunta', sub: clip(q, 25), status: 'run', tip: q },
            true
          )
        )
        break
      }
      case 'answer': {
        const n = this.questions.get(str(ev.qid))
        if (!n) return
        n.status = 'ok'
        n.sub = clip(`→ ${str(ev.answer) || 'sem resposta'}`, 25)
        n.tip += `\n→ ${str(ev.answer)}`
        break
      }
      case 'verdict': {
        const approve = ev.verdict === 'approve'
        this.addNode(
          this.curStage ?? this.lastLane ?? this.lane(a),
          {
            kind: 'verdict',
            title: `revisor: ${approve ? 'aprova' : 'rejeita'}`,
            sub: clip(ev.feedback, 25),
            status: approve ? 'ok' : 'err',
            tip: str(ev.feedback) || 'revisor'
          },
          true
        )
        break
      }
      case 'notice': {
        const t = str(ev.text)
        if (t.startsWith('escalated')) {
          const to = (t.split('->')[1] ?? '').split(':')[0].trim().split('/').pop()
          this.addNode(this.lane(a), { kind: 'esc', title: 'escalonamento', sub: clip(to, 25), tip: t }, true)
        } else if (ev.level === 'warn' && !/retrying|fallback/.test(t) && this.laneBy.has(a)) {
          this.addNode(this.lane(a), { kind: 'warn', title: 'aviso', sub: clip(t, 25), tip: t }, true)
        } else return
        break
      }
      case 'compact': {
        const L = this.laneBy.get(a)
        if (ev.tier !== 2 || !L) return
        this.addNode(
          L,
          { kind: 'mark', title: 'compactação', sub: 'contexto resumido', tip: 'sumarização do histórico' },
          true
        )
        break
      }
      case 'hook': {
        if (ev.action !== 'deny' && ev.action !== 'push') return
        const message = str(ev.message)
        this.addNode(
          this.anyLane(a),
          {
            kind: 'warn',
            title: ev.event === 'pre_finish' ? 'regra: ainda não' : 'regra: bloqueado',
            sub: clip(message, 25),
            tip: message || 'regra do projeto'
          },
          true
        )
        break
      }
      default:
        return
    }
    this.version++
  }

  layout(): FlowLayout {
    let x = PAD
    for (const L of this.lanes) {
      L.x = x
      L.w = L.cols * (FLOW_NODE_W + GX) - GX
      x += L.w + LANE_GAP
    }
    const width = Math.max(x - LANE_GAP + PAD, 300)
    const height = PAD * 2 + Math.max(this.row, 1) * (FLOW_NODE_H + GY)
    for (const n of this.nodes) {
      const L = this.nodeLane.get(n)!
      const rowW = L.rows[n.row] * (FLOW_NODE_W + GX) - GX
      n.x = L.x + (L.w - rowW) / 2 + n.col * (FLOW_NODE_W + GX)
      n.y = PAD + (n.row - 1) * (FLOW_NODE_H + GY)
    }
    const edges = this.edges.map((e): FlowEdge => {
      const sx = e.a.x + FLOW_NODE_W / 2
      const sy = e.a.y + FLOW_NODE_H
      const tx = e.b.x + FLOW_NODE_W / 2
      const ty = e.b.y - 1
      let d: string
      if (ty > sy) {
        const my = (sy + ty) / 2
        d = Math.abs(sx - tx) < 1 ? `M${sx} ${sy}L${tx} ${ty}` : `M${sx} ${sy}C${sx} ${my},${tx} ${my},${tx} ${ty}`
      } else {
        const ox = Math.max(e.a.x, e.b.x) + FLOW_NODE_W + 26
        const ay = e.a.y + FLOW_NODE_H / 2
        const by = e.b.y + FLOW_NODE_H / 2
        d = `M${e.a.x + FLOW_NODE_W} ${ay}C${ox} ${ay},${ox} ${by},${e.b.x + FLOW_NODE_W + 1} ${by}`
      }
      return { d, cross: !!e.cross, label: e.label || undefined, labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 - 3 }
    })
    return {
      width,
      height,
      lanes: this.lanes.map((L) => ({ x: L.x, width: L.w })),
      nodes: this.nodes,
      edges,
      agents: this.lanes.length,
      toolCalls: this.nodes.filter((n) => n.kind === 'tool').length,
      steps: this.row,
      running: this.running
    }
  }
}

/** Event types the graph reads; everything else (deltas, tokens) is not sent to the renderer for it. */
export const FLOW_EVENT_TYPES: ReadonlySet<string> = new Set([
  'graph',
  'node_start',
  'node_end',
  'llm_start',
  'tool_start',
  'tool_end',
  'permission',
  'permission_result',
  'question',
  'answer',
  'verdict',
  'notice',
  'compact',
  'hook'
])
