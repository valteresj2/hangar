// Início: the native equivalent of the portal's member home (memberHome) — what waits for the person, their
// agents, who is working now, the month's cost, recent decisions and what they opened recently. Details open the
// portal until they move to the app.
import type { WorkspaceState } from '@shared/features/workspace'
import { useUi } from '../../core/ui'
import { openPortal } from './api'
import { ago, count, DECISION_KIND, EMPLOYEE_STATUS, greeting, statusOf, TASK_STATUS, usd } from './format'
import { AgentAvatar, CardHeader, Kpi } from './parts'
import { LiveNote, LoadState } from './WorkspaceView'
import styles from './workspace.module.css'

export function HomeView({ state }: { state: WorkspaceState }) {
  const home = state.home.data
  const decisions = (state.decisions.data ?? []).filter((d) => d.kind !== 'notice')
  const agents = home?.agents ?? []
  const working = agents.filter((a) => a.workingOn)
  const first = state.firstName

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.h1}>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <div className={styles.sub}>
            {home?.workspace ? (
              <>
                Workspace <b>{home.workspace}</b>
              </>
            ) : (
              'Agent Hangar'
            )}{' '}
            · <LiveNote state={state} />
          </div>
        </div>
        <div className={styles.headActions}>
          <button className="btn" onClick={() => openPortal({ screen: 'connect-ai' })}>
            Conectar minha IA ↗
          </button>
          <button className="btn" onClick={() => openPortal({ screen: 'home' })}>
            Abrir no portal ↗
          </button>
        </div>
      </div>

      <LoadState parts={[state.home, state.decisions]} scope="home">
        {home && !home.llmReady && (
          <div className={`${styles.card} ${styles.warnCard}`}>
            A plataforma ainda não tem um provedor de LLM: os agentes respondem com um <b>modelo de teste</b> (respostas
            fictícias, sem custo) até um admin cadastrar um.
          </div>
        )}

        <div className={styles.board}>
          <Kpi value={count(state.decisions.data ? decisions.length : home?.toDecide)} label="Para você decidir" />
          <Kpi value={count(home ? agents.length + home.builtAgents.length : undefined)} label="Meus agentes" />
          <Kpi value={count(home ? working.length : undefined)} label="Trabalhando agora" />
          <Kpi value={usd(home?.monthCostUsd)} label="Custo no mês" />
        </div>
        {home && (home.personalCount > 0 || home.personalCapUsd > 0) && (
          <div className={`muted ${styles.small}`}>
            Agentes pessoais: {home.personalCount}/{home.personalMax} · gasto no mês {usd(home.personalSpentUsd)}
            {home.personalCapUsd ? ` / ${usd(home.personalCapUsd)}` : ''}
          </div>
        )}

        <div className={styles.grid}>
          <div className={`${styles.card} ${decisions.length ? styles.attention : ''}`}>
            <CardHeader title="Decisões" action="Abrir →" onAction={() => openPortal({ screen: 'decisions' })} />
            {decisions.length ? (
              <ul className={styles.list}>
                {decisions.slice(0, 6).map((d) => (
                  <li key={d.id}>
                    <button
                      className={`${styles.linkBtn} ${styles.rowText}`}
                      title={d.question ?? d.taskTitle}
                      onClick={() => openPortal({ screen: 'decision', id: d.id })}
                    >
                      <b>{d.employeeName || 'Agente'}</b> · {DECISION_KIND[d.kind] ?? (d.kind || 'decisão')}
                      {d.question || d.taskTitle ? ` — ${d.question ?? d.taskTitle}` : ''}
                    </button>
                    <span className={`muted ${styles.small}`}>{ago(d.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">Nada esperando por você.</div>
            )}
          </div>

          <div className={styles.card}>
            <CardHeader
              title="Trabalhando agora"
              action="Organograma →"
              onAction={() => openPortal({ screen: 'org' })}
            />
            {working.length ? (
              <ul className={styles.list}>
                {working.map((a) => (
                  <li key={a.slug}>
                    <button
                      className={styles.linkBtn}
                      onClick={() => openPortal({ screen: 'employee', slug: a.slug }, a.name)}
                    >
                      <b>{a.name}</b>
                    </button>
                    <span className={styles.chip} title={a.workingOn?.title}>
                      Trabalhando em: {a.workingOn?.title}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">Nenhum dos seus agentes está numa tarefa agora.</div>
            )}
          </div>

          <div className={styles.card}>
            <CardHeader
              title="Minhas tarefas"
              action="Minhas issues →"
              onAction={() => openPortal({ screen: 'my-issues' })}
            />
            {home?.myTasks.length ? (
              <ul className={styles.list}>
                {home.myTasks.map((t) => {
                  const st = statusOf(TASK_STATUS, t.status)
                  return (
                    <li key={t.id}>
                      <button
                        className={`${styles.linkBtn} ${styles.rowText}`}
                        title={t.title}
                        onClick={() => openPortal({ screen: 'task', id: t.id }, `Tarefa: ${t.title}`)}
                      >
                        {t.title}
                      </button>
                      <span className={st.className}>{st.label}</span>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="muted">
                Você ainda não pediu tarefas aos agentes. Peça pela página do agente ou pela sua IA conectada.
              </div>
            )}
          </div>

          <div className={styles.card}>
            <CardHeader
              title="Meus agentes"
              action="Ver todos →"
              onAction={() => useUi.getState().openWorkspace('agents')}
            />
            {agents.length || home?.builtAgents.length ? (
              <ul className={styles.list}>
                {agents.slice(0, 6).map((a) => {
                  const st = statusOf(EMPLOYEE_STATUS, a.status)
                  return (
                    <li key={a.slug}>
                      <button
                        className={styles.linkBtn}
                        onClick={() => openPortal({ screen: 'employee', slug: a.slug }, a.name)}
                      >
                        <AgentAvatar name={a.name} /> <b>{a.name}</b>
                      </button>
                      <span>
                        {a.personal && <span className="pill pill-info">pessoal</span>}{' '}
                        <span className={st.className}>{st.label}</span>
                      </span>
                    </li>
                  )
                })}
                {(home?.builtAgents ?? []).slice(0, Math.max(0, 6 - agents.length)).map((a) => (
                  <li key={`agent:${a.slug}`}>
                    <button
                      className={styles.linkBtn}
                      onClick={() => openPortal({ screen: 'agent', slug: a.slug }, a.name)}
                    >
                      <AgentAvatar name={a.name} /> <b>{a.name}</b>
                    </button>
                    <span className={styles.chip}>agente</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">Nenhum agente seu ainda.</div>
            )}
          </div>
        </div>

        <div className={styles.card} data-card="recent">
          <CardHeader title="Vistos recentemente" />
          {state.recent.length ? (
            <div className={styles.chips}>
              {state.recent.map((r) => (
                <button
                  key={`${r.target.screen}:${'slug' in r.target ? r.target.slug : 'id' in r.target ? r.target.id : ''}`}
                  className={styles.recentChip}
                  title={`Aberto ${ago(r.at)}`}
                  onClick={() => openPortal(r.target, r.label)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="muted">Os agentes e tarefas que você abrir por aqui aparecem nesta lista.</div>
          )}
        </div>
      </LoadState>
    </div>
  )
}
