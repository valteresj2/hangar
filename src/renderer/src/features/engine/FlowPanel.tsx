// Side-panel tab "Grafo": the live workflow graph of a Hangar-engine session. Nodes appear as the agent works —
// one lane per agent, one row per model turn — from the events the main process records (engine/hangar/flow.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import { FLOW_NODE_H, FLOW_NODE_W, FlowGraph, type FlowNode } from '@shared/flow'
import { bridge } from '../../core/api'
import { useSettings } from '../../core/data'
import { useProviders } from './providers'
import styles from './flow.module.css'

/** The engine a session runs on, from its provider profile ('claude' while the profiles load). */
export function useSessionEngine(session: Session | undefined): 'claude' | 'hangar' {
  const providers = useProviders()
  const settings = useSettings()
  if (!session) return 'claude'
  const profile = providers.find((p) => p.id === (session.providerId || settings?.defaultProviderId))
  return profile?.engine === 'hangar' ? 'hangar' : 'claude'
}

function useFlow(sessionId: string): { graph: FlowGraph; version: number } {
  const [state, setState] = useState(() => ({ graph: new FlowGraph(), version: 0 }))
  useEffect(() => {
    let graph = new FlowGraph()
    let loaded = false
    let alive = true
    const early: Parameters<FlowGraph['on']>[0][] = []
    setState({ graph, version: 0 })
    const off = bridge.on(ENGINE.evFlow, ({ sessionId: id, event }) => {
      if (id !== sessionId) return
      if (!loaded) return void early.push(event)
      graph.on(event)
      setState({ graph, version: graph.version })
    })
    void bridge.invoke(ENGINE.flowEvents, sessionId).then(
      (events) => {
        if (!alive) return
        graph = new FlowGraph()
        // Events that arrived while the history loaded are already at its end.
        for (const ev of events.length ? events : early) graph.on(ev)
        loaded = true
        setState({ graph, version: graph.version })
      },
      () => {
        loaded = true
      }
    )
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return state
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function clipTitle(s: string): string {
  return s.length > 22 ? `${s.slice(0, 21)}…` : s
}

function Graph({ sessionId }: { sessionId: string }) {
  const { graph, version } = useFlow(sessionId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the graph mutates in place; `version` is its change counter
  const layout = useMemo(() => graph.layout(), [graph, version])
  const [scale, setScale] = useState(1)
  const [follow, setFollow] = useState(true)
  const [picked, setPicked] = useState<FlowNode>()
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => setPicked(undefined), [sessionId])

  const last = layout.nodes[layout.nodes.length - 1]
  useEffect(() => {
    const box = scroller.current
    if (!box || !follow || !last || !layout.running) return
    box.scrollTop = Math.max(0, (last.y + FLOW_NODE_H) * scale - box.clientHeight + 60)
    const left = last.x * scale
    const right = (last.x + FLOW_NODE_W) * scale
    // Pan sideways only when the new node is off screen.
    if (left < box.scrollLeft || right > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, left - 40)
  }, [last, layout.running, follow, scale, version])

  const fit = () => {
    const box = scroller.current
    if (box) setScale(Math.min(1, Math.max(0.3, (box.clientWidth - 8) / layout.width)))
  }
  const zoom = (step: number) => setScale((s) => Math.min(2, Math.max(0.3, s + step * 0.15)))

  const info = layout.nodes.length
    ? `${layout.agents} agente${layout.agents > 1 ? 's' : ''} · ${layout.toolCalls} chamada${
        layout.toolCalls !== 1 ? 's' : ''
      } de ferramenta · ${layout.steps} passos`
    : 'O grafo aparece aqui conforme o agente trabalha.'

  return (
    <div className={styles.flow}>
      <div className={styles.bar}>
        <strong>Grafo ao vivo</strong>
        {layout.running && <span className={styles.live}>ao vivo</span>}
        <span className={styles.info}>{info}</span>
        <span className={styles.spacer} />
        <label className={styles.follow}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir
        </label>
        <button onClick={fit} title="Encaixar o grafo na largura">
          ajustar
        </button>
        <button onClick={() => zoom(-1)} title="Diminuir" aria-label="Diminuir">
          −
        </button>
        <button onClick={() => setScale(1)} title="Tamanho real">
          {Math.round(scale * 100)}%
        </button>
        <button onClick={() => zoom(1)} title="Aumentar" aria-label="Aumentar">
          +
        </button>
      </div>
      <div className={styles.scroll} ref={scroller}>
        {layout.nodes.length === 0 ? (
          <p className={styles.empty}>
            Envie uma mensagem: cada rodada do modelo vira uma linha, cada ferramenta um nó, e cada sub-agente ganha a
            sua própria raia.
          </p>
        ) : (
          <svg
            role="img"
            aria-label="Grafo do trabalho do agente"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width * scale}
            height={layout.height * scale}
          >
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0 0L8 4L0 8z" className={styles.arrow} />
              </marker>
            </defs>
            {layout.lanes.map((L, i) => (
              <rect
                key={i}
                className={styles.lane}
                x={L.x - 8}
                y={6}
                width={L.width + 16}
                height={layout.height - 12}
                rx={10}
              />
            ))}
            {layout.edges.map((e, i) => (
              <g key={i}>
                <path
                  className={`${styles.edge} ${e.cross ? styles.cross : ''}`}
                  d={e.d}
                  markerEnd="url(#flow-arrow)"
                />
                {e.label && (
                  <text className={styles.edgeLabel} x={e.labelX} y={e.labelY} textAnchor="middle">
                    {e.label}
                  </text>
                )}
              </g>
            ))}
            {layout.nodes.map((n) => (
              <g
                key={n.id}
                className={`${styles.node} ${styles[`k_${n.kind}`] ?? ''} ${n.status ? styles[`s_${n.status}`] : ''} ${
                  picked?.id === n.id ? styles.picked : ''
                }`}
                data-kind={n.kind}
                data-status={n.status ?? 'none'}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => setPicked(n)}
              >
                <title>{n.tip}</title>
                <rect className={styles.box} width={FLOW_NODE_W} height={FLOW_NODE_H} rx={7} />
                <rect className={styles.stripe} width={4} height={FLOW_NODE_H - 10} x={5} y={5} rx={2} />
                <text className={styles.t1} x={15} y={15}>
                  {clipTitle(n.title)}
                </text>
                <text className={styles.t2} x={15} y={29}>
                  {n.sub}
                </text>
                {n.ms !== undefined && (
                  <text className={styles.t3} x={FLOW_NODE_W - 7} y={15} textAnchor="end">
                    {duration(n.ms)}
                  </text>
                )}
              </g>
            ))}
          </svg>
        )}
      </div>
      {picked && (
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            <strong>{picked.title}</strong>
            {picked.ms !== undefined && <span>{duration(picked.ms)}</span>}
            <span className={styles.spacer} />
            <button onClick={() => setPicked(undefined)} aria-label="Fechar detalhe">
              ×
            </button>
          </div>
          <pre>{picked.tip}</pre>
        </div>
      )}
    </div>
  )
}

export function FlowPanel({ session }: { session: Session }) {
  const engine = useSessionEngine(session)
  if (engine !== 'hangar')
    return (
      <div className={styles.flow}>
        <div className={styles.bar}>
          <strong>Grafo ao vivo</strong>
        </div>
        <p className={styles.empty}>
          O grafo ao vivo acompanha sessões do motor Hangar Harness. Escolha um perfil de gateway com esse motor em
          Configurações → Provedores.
        </p>
      </div>
    )
  return <Graph key={session.id} sessionId={session.id} />
}
