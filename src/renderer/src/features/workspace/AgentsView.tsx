// Meus agentes: the person's Digital employees (personal ones and the team's they manage, with model, harness and
// level from the org chart) and the plain agents they own, maintain or created — status, kind and last use. The
// detail opens the portal until it moves to the app (M3); "Conversar" opens a session that talks to the agent
// through the Agent Hangar tools every session gets while the app is connected.
import type { ReactNode } from 'react'
import { NEW_SESSION_PRESET_EVENT, type NewSessionPreset } from '@shared/features/sessions'
import type {
  WorkspaceBuiltAgent,
  WorkspaceChartNode,
  WorkspaceEmployee,
  WorkspaceState
} from '@shared/features/workspace'
import { openPortal } from './api'
import { AGENT_STATUS, ago, BUILT_WHY, EMPLOYEE_STATUS, LEVEL_LABEL, statusOf, usd, when } from './format'
import { AgentAvatar } from './parts'
import { LiveNote, LoadState } from './WorkspaceView'
import styles from './workspace.module.css'

type Employee = WorkspaceEmployee & Partial<Pick<WorkspaceChartNode, 'level' | 'model' | 'harness'>>

/** New session filled in to talk to the agent: its role first, then the person's messages (both editable). */
function talkTo(name: string, slug: string, employee: boolean): void {
  const detail: NewSessionPreset = employee
    ? {
        title: `Conversa · ${name}`,
        prompt:
          `Quero falar com o funcionário digital "${name}" (${slug}) do Agent Hangar. Primeiro me diga qual é o papel ` +
          'dele, o status e se há tarefas ou decisões abertas. Depois, passe para ele as tarefas que eu pedir e me ' +
          'mostre os resultados.'
      }
    : {
        title: `Conversa · ${name}`,
        prompt:
          `Quero conversar com o agente "${name}" (${slug}) do Agent Hangar. Primeiro me diga qual é o papel dele e o ` +
          'que ele faz (pelo guia dele). Depois, repasse para ele o que eu escrever e me mostre as respostas.'
      }
  window.dispatchEvent(new CustomEvent(NEW_SESSION_PRESET_EVENT, { detail }))
}

function TalkButton({ name, slug, employee }: { name: string; slug: string; employee: boolean }) {
  return (
    <button className="btn" title="Abre uma sessão para conversar com ele" onClick={() => talkTo(name, slug, employee)}>
      Conversar
    </button>
  )
}

function LastUse({ at, working }: { at?: string; working?: boolean }) {
  const text = working ? 'agora' : ago(at)
  return <span className={styles.chip}>Último uso: {text || '—'}</span>
}

function EmployeeRow({ a }: { a: Employee }) {
  const st = statusOf(EMPLOYEE_STATUS, a.status)
  const level = a.level ?? a.autonomyLevel
  const open = () => openPortal({ screen: 'employee', slug: a.slug }, a.name)
  return (
    <div className={`${styles.card} ${styles.agentRow}`} data-agent={a.slug}>
      <div className={styles.agentHead}>
        <div className={styles.agentMain}>
          <button className={styles.agentName} onClick={open}>
            <AgentAvatar name={a.name} size={24} /> <b>{a.name}</b>
          </button>
          <span className={styles.kind}>Digital employee</span>
          {a.personal && <span className="pill pill-info">pessoal</span>}
          <span className={st.className}>{st.label}</span>
          {a.title && <div className={`muted ${styles.small} ${styles.oneLine}`}>{a.title}</div>}
        </div>
        <div className={styles.agentActions}>
          <TalkButton name={a.name} slug={a.slug} employee />
          <button className="btn" onClick={open}>
            Abrir ↗
          </button>
        </div>
      </div>
      <div className={styles.chips}>
        {a.model && <span className={styles.chip}>{a.model}</span>}
        {a.harness && <span className={styles.chip}>harness {a.harness}</span>}
        {level && <span className={styles.chip}>{LEVEL_LABEL[level] ?? level}</span>}
        {a.team && <span className={styles.chip}>{a.team}</span>}
        {a.openDecisions > 0 && (
          <span className="pill pill-hold">
            {a.openDecisions} {a.openDecisions === 1 ? 'decisão' : 'decisões'}
          </span>
        )}
        {a.overdueTasks > 0 && <span className="pill pill-stop">{a.overdueTasks} atrasada(s)</span>}
        <span className={styles.chip}>30 dias: {usd(a.cost30dUsd)}</span>
        <LastUse at={a.lastUsedAt} working={!!a.workingOn} />
        {a.workingOn && (
          <span className={styles.chip} title={a.workingOn.title}>
            Trabalhando em: {a.workingOn.title}
          </span>
        )}
      </div>
    </div>
  )
}

function BuiltRow({ a }: { a: WorkspaceBuiltAgent }) {
  const st = statusOf(AGENT_STATUS, a.status)
  const open = () => openPortal({ screen: 'agent', slug: a.slug }, a.name)
  return (
    <div className={`${styles.card} ${styles.agentRow}`} data-agent={a.slug}>
      <div className={styles.agentHead}>
        <div className={styles.agentMain}>
          <button className={styles.agentName} onClick={open}>
            <AgentAvatar name={a.name} size={24} /> <b>{a.name}</b>
          </button>
          <span className={styles.kind}>Agente</span>
          <span className={st.className}>{st.label}</span>
          {a.why && <span className="pill">{BUILT_WHY[a.why] ?? a.why}</span>}
          {a.objective && <div className={`muted ${styles.small} ${styles.oneLine}`}>{a.objective}</div>}
        </div>
        <div className={styles.agentActions}>
          <TalkButton name={a.name} slug={a.slug} employee={false} />
          <button className="btn" onClick={open}>
            Abrir ↗
          </button>
        </div>
      </div>
      <div className={styles.chips}>
        {a.version && <span className={styles.chip}>v{a.version}</span>}
        {a.team && <span className={styles.chip}>{a.team}</span>}
        {a.schedules > 0 && (
          <span className={styles.chip}>agendado{a.nextRunAt ? ` · próxima ${when(a.nextRunAt)}` : ''}</span>
        )}
        <span className={styles.chip}>30 dias: {usd(a.cost30dUsd)}</span>
        <LastUse at={a.lastUsedAt} />
      </div>
    </div>
  )
}

function Group({
  title,
  count,
  empty,
  children
}: {
  title: string
  count: number
  empty: string
  children: ReactNode
}) {
  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>
        {title} <span className="muted">({count})</span>
      </h2>
      {count ? children : <div className={`${styles.card} muted`}>{empty}</div>}
    </section>
  )
}

export function AgentsView({ state }: { state: WorkspaceState }) {
  const home = state.home.data
  const nodes = new Map((state.chart.data?.nodes ?? []).map((n) => [n.slug, n]))
  const employees: Employee[] = (home?.agents ?? []).map((a) => {
    const n = nodes.get(a.slug)
    return n
      ? {
          ...a,
          level: n.level,
          model: n.model,
          harness: n.harness,
          team: a.team ?? n.team,
          workingOn: a.workingOn ?? n.workingOn
        }
      : a
  })
  const personal = employees.filter((a) => a.personal)
  const team = employees.filter((a) => !a.personal)
  const built = home?.builtAgents ?? []

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.h1}>Meus agentes</h1>
          <div className={styles.sub}>
            Os seus agentes pessoais, os do time que você gerencia e os agentes que você criou ou mantém ·{' '}
            <LiveNote state={state} />
          </div>
        </div>
        <div className={styles.headActions}>
          {home?.personalAllowed && (
            <button className="btn" onClick={() => openPortal({ screen: 'mine' })}>
              Novo agente pessoal ↗
            </button>
          )}
          <button className="btn" onClick={() => openPortal({ screen: 'mine' })}>
            Abrir no portal ↗
          </button>
        </div>
      </div>

      <LoadState parts={[state.home, state.chart]} scope="agents">
        {home && home.personalAllowed && (
          <div className={`muted ${styles.small}`}>
            Agentes pessoais: {home.personalCount}/{home.personalMax}
            {home.personalCapUsd
              ? ` · orçamento do mês ${usd(home.personalSpentUsd)} / ${usd(home.personalCapUsd)}`
              : ''}
          </div>
        )}
        <Group title="Pessoais" count={personal.length} empty="Nenhum agente pessoal ainda.">
          {personal.map((a) => (
            <EmployeeRow key={a.slug} a={a} />
          ))}
        </Group>
        <Group title="Do time, que eu gerencio" count={team.length} empty="Nenhum agente do time sob sua gestão.">
          {team.map((a) => (
            <EmployeeRow key={a.slug} a={a} />
          ))}
        </Group>
        <Group title="Agentes que eu criei ou mantenho" count={built.length} empty="Nenhum agente comum seu ainda.">
          {built.map((a) => (
            <BuiltRow key={a.slug} a={a} />
          ))}
        </Group>
      </LoadState>
    </div>
  )
}
