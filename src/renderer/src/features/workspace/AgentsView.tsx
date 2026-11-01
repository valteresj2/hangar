// Meus agentes: the person's Digital employees (personal ones and the team's they manage, with model, harness and
// level from the org chart) and the plain agents they own, maintain or created — status, kind and last use. The
// detail opens the portal until it moves to the app (M3); "Conversar" opens a session that talks to the agent
// through the Agent Hangar tools every session gets while the app is connected.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NEW_SESSION_PRESET_EVENT, type NewSessionPreset } from '@shared/features/sessions'
import type {
  AgentAction,
  AgentDetail,
  WorkspaceBuiltAgent,
  WorkspaceChartNode,
  WorkspaceEmployee,
  WorkspaceState
} from '@shared/features/workspace'
import { openPortal, workspaceApi } from './api'
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

/** What "Novo agente" offers: the request for each kind, with blanks for the person to fill in before sending. */
export const NEW_AGENT_TEMPLATES: { kind: string; label: string; hint: string; preset: NewSessionPreset }[] = [
  {
    kind: 'simple',
    label: 'Agente simples',
    hint: 'Um agente para uma tarefa, como resumir textos ou responder dúvidas.',
    preset: {
      title: 'Novo agente',
      prompt:
        'Quero criar um agente no Agent Hangar.\n' +
        'Objetivo: [o que ele deve fazer]\n' +
        'Entrada: [o que ele recebe]\n' +
        'Saída: [o que ele devolve]\n\n' +
        'Planeje o agente, crie, teste em stage e me mostre o resultado dos testes antes de publicar em produção.'
    }
  },
  {
    kind: 'multi',
    label: 'Multiagente',
    hint: 'Uma equipe de agentes, cada um com um papel, coordenada por um orquestrador.',
    preset: {
      title: 'Novo multiagente',
      prompt:
        'Quero montar um multiagente no Agent Hangar.\n' +
        'Objetivo da equipe: [o que a equipe entrega]\n' +
        'Papéis: [por exemplo: um extrai os pontos-chave, outro escreve, outro revisa]\n' +
        'Entrada: [o que a equipe recebe]\n' +
        'Saída: [o que a equipe devolve]\n\n' +
        'Planeje a equipe, crie os agentes e o orquestrador, teste em stage e me mostre o resultado antes de publicar.'
    }
  },
  {
    kind: 'employee',
    label: 'Digital employee',
    hint: 'Um funcionário digital com cargo, gestor, alçada e caixa de tarefas.',
    preset: {
      title: 'Novo digital employee',
      prompt:
        'Quero contratar um digital employee no Agent Hangar.\n' +
        'Cargo: [o nome do cargo]\n' +
        'Missão: [para que ele existe]\n' +
        'Responsabilidades: [pelo menos três]\n' +
        'Sistemas e ferramentas: [o que ele usa no trabalho]\n\n' +
        'Monte o plano de contratação, me mostre para eu aprovar e só então contrate. Depois, passe uma tarefa de ' +
        'teste e me mostre o resultado.'
    }
  }
]

function startNewAgent(preset: NewSessionPreset): void {
  window.dispatchEvent(new CustomEvent(NEW_SESSION_PRESET_EVENT, { detail: preset }))
}

/** "Novo agente": a session filled in with the request for the chosen kind (the portal stays one click away). */
/** Width of the "Novo agente" menu (keep in sync with `.menu` in workspace.module.css). */
const MENU_WIDTH = 300

function NewAgentMenu({ portal }: { portal: boolean }) {
  const [open, setOpen] = useState(false)
  // Placed on the screen, under the button and inside the window: in a narrow window the header's buttons wrap to
  // the left, and a menu hanging off the button's right edge ended up under the sidebar, where it could not be clicked.
  const [at, setAt] = useState<{ top: number; left: number }>()
  const box = useRef<HTMLDivElement>(null)
  const toggle = (button: HTMLElement) => {
    if (open) return setOpen(false)
    const r = button.getBoundingClientRect()
    // From the button's left edge, moved left only as much as the window's right edge requires.
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)) })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // The menu is placed on the screen: scrolling or resizing would leave it behind, so it closes.
    const onMove = (e: Event) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target))) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])
  return (
    <div className={styles.menuBox} ref={box}>
      <button
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => toggle(e.currentTarget)}
      >
        Novo agente ▾
      </button>
      {open && (
        <div className={styles.menu} role="menu" style={at}>
          {NEW_AGENT_TEMPLATES.map((t) => (
            <button
              key={t.kind}
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false)
                startNewAgent(t.preset)
              }}
            >
              <span className={styles.menuLabel}>{t.label}</span>
              <span className={styles.menuHint}>{t.hint}</span>
            </button>
          ))}
          {portal && (
            <button
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false)
                void openPortal({ screen: 'mine' })
              }}
            >
              <span className={styles.menuLabel}>Agente pessoal no portal ↗</span>
              <span className={styles.menuHint}>O formulário de agente pessoal da plataforma.</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** What the "Gerenciar" panel offers, from the agent's state and the person's permissions on the platform. */
export function actionsFor(d: AgentDetail, employeeStatus?: string): { action: AgentAction; label: string }[] {
  const can = (p: string) => d.permissions.includes(p)
  const out: { action: AgentAction; label: string }[] = []
  if (employeeStatus !== undefined) {
    if (['probation', 'active'].includes(employeeStatus)) out.push({ action: 'pause', label: 'Pausar' })
    if (employeeStatus === 'paused') out.push({ action: 'resume', label: 'Retomar' })
    if (employeeStatus !== 'offboarded') out.push({ action: 'offboard', label: 'Desligar' })
    if (employeeStatus === 'offboarded' && can('manage')) out.push({ action: 'delete', label: 'Excluir' })
    return out
  }
  if (can('edit')) out.push({ action: 'ship', label: 'Testar e publicar' })
  if (d.stageVersion && can('edit')) out.push({ action: 'stop-stage', label: 'Parar stage' })
  if (d.prodVersion && can('manage')) out.push({ action: 'stop-prod', label: 'Parar produção' })
  if (can('manage')) out.push({ action: 'delete', label: 'Excluir' })
  return out
}

const EMPTY_DETAIL: AgentDetail = { slug: '', name: '', kind: '', status: '', permissions: [], versions: [] }

const CONFIRM: Partial<Record<AgentAction, (name: string) => string>> = {
  delete: (name) => `Excluir "${name}" de vez? Os containers, o histórico de uso e os agendamentos saem junto.`,
  offboard: (name) =>
    `Desligar "${name}"? As tarefas abertas são canceladas e ele sai do ar; o histórico continua guardado.`,
  'stop-prod': (name) => `Parar "${name}" em produção? Quem usa o agente fica sem ele até a próxima publicação.`
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** Where the agent runs, its model, cost, last test and versions. */
function AgentFacts({ detail }: { detail: AgentDetail }) {
  return (
    <>
      <div className={styles.chips}>
        <span className={styles.chip}>Stage: {detail.stageVersion ? `v${detail.stageVersion} no ar` : 'parado'}</span>
        <span className={styles.chip}>Produção: {detail.prodVersion ? `v${detail.prodVersion} no ar` : 'parado'}</span>
        {detail.model && <span className={styles.chip}>{detail.model}</span>}
        {detail.cost7d !== undefined && <span className={styles.chip}>7 dias: {usd(detail.cost7d)}</span>}
        {detail.requests7d !== undefined && <span className={styles.chip}>{detail.requests7d} chamadas em 7 dias</span>}
        {detail.lastTest && (
          <span className={styles.chip}>
            Último teste{detail.lastTest.version ? ` (v${detail.lastTest.version})` : ''}: {detail.lastTest.status}
            {detail.lastTest.summary ? ` · ${detail.lastTest.summary}` : ''}
          </span>
        )}
      </div>
      {detail.versions.length > 0 && (
        <details>
          <summary className={styles.small}>Versões ({detail.versions.length})</summary>
          <ul className={styles.versions}>
            {detail.versions.slice(0, 10).map((v) => (
              <li key={v.version}>
                v{v.version}
                {v.version === detail.version ? ' (atual)' : ''}
                {v.createdBy ? ` · ${v.createdBy}` : ''}
                {v.createdAt ? ` · ${when(v.createdAt)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/** Versions, where each runs, the last test and the cost, with the actions the person may take. */
function ManagePanel({ slug, name, employeeStatus }: { slug: string; name: string; employeeStatus?: string }) {
  const [detail, setDetail] = useState<AgentDetail>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<AgentAction>()
  const [done, setDone] = useState<string>()

  // Loaded when the panel opens and again after each action (`round`).
  const [round, setRound] = useState(0)
  useEffect(() => {
    let alive = true
    workspaceApi
      .agent(slug)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setError(undefined)
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [slug, round])

  const run = async (action: AgentAction, label: string) => {
    const ask = CONFIRM[action]
    if (ask && !window.confirm(ask(name))) return
    setBusy(action)
    setError(undefined)
    setDone(undefined)
    try {
      const out = await workspaceApi.agentAction(slug, action)
      setDone(out.message || `${label}: feito.`)
      if (action !== 'delete') setRound((n) => n + 1)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(undefined)
    }
  }

  // A Digital employee's lifecycle actions do not depend on the agent's detail: they stay when it fails to load.
  if (!detail && !(error && employeeStatus !== undefined))
    return (
      <div className={styles.manage}>
        {error ? (
          <div className={styles.decisionError} role="alert">
            {error}
          </div>
        ) : (
          <span className="muted">Carregando…</span>
        )}
      </div>
    )
  const actions = actionsFor(detail ?? EMPTY_DETAIL, employeeStatus)
  return (
    <div className={styles.manage} data-manage={slug}>
      {detail && <AgentFacts detail={detail} />}
      {error && (
        <div className={styles.decisionError} role="alert">
          {error}
        </div>
      )}
      {done && (
        <div className={styles.decisionDone} role="status">
          {done}
        </div>
      )}
      <div className={styles.decisionActions}>
        {actions.length === 0 && <span className={`muted ${styles.small}`}>Você só pode ver este agente.</span>}
        {actions.map((a) => (
          <button
            key={a.action}
            className={a.action === 'delete' || a.action === 'offboard' ? 'btn btn-danger' : 'btn'}
            disabled={!!busy}
            onClick={() => void run(a.action, a.label)}
          >
            {busy === a.action ? (a.action === 'ship' ? 'Testando e publicando…' : 'Aguarde…') : a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ManageButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button className="btn" aria-expanded={open} onClick={onClick}>
      {open ? 'Fechar' : 'Gerenciar'}
    </button>
  )
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
  const [managing, setManaging] = useState(false)
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
          <ManageButton open={managing} onClick={() => setManaging(!managing)} />
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
      {managing && <ManagePanel slug={a.slug} name={a.name} employeeStatus={a.status} />}
    </div>
  )
}

function BuiltRow({ a }: { a: WorkspaceBuiltAgent }) {
  const st = statusOf(AGENT_STATUS, a.status)
  const open = () => openPortal({ screen: 'agent', slug: a.slug }, a.name)
  const [managing, setManaging] = useState(false)
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
          <ManageButton open={managing} onClick={() => setManaging(!managing)} />
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
      {managing && <ManagePanel slug={a.slug} name={a.name} />}
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
          <NewAgentMenu portal={!!home?.personalAllowed} />
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
