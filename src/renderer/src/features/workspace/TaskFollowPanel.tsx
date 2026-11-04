// The platform tasks this session follows, at the bottom of the session (above the composer): status, the employee's
// plan, the latest steps of the timeline (each tool the employee ran), its long jobs with a bar and when they should end,
// cost, the decisions it waits for (decided right in the card), the tasks it
// handed off (cards inside its card), the deliverables (open with a click) and, at the end, the full result. Live: main
// pushes each change (task.updated). The session answers on its own when a task ends (turn it off per task).
import { useEffect, useState, type ReactNode } from 'react'
import { TASK_DONE, TASK_WAITING, type FollowedTask, type TaskFile } from '@shared/features/workspace'
import { loadFollowedTasks, openPortal, useFollowedTasks, useWorkspace, workspaceApi } from './api'
import { DecisionCard } from './DecisionsView'
import { usd } from './format'
import styles from './workspace.module.css'

const STATUS: Record<string, [string, string]> = {
  new: ['na fila', 'pill pill-info'],
  in_progress: ['trabalhando', 'pill pill-go'],
  waiting_human: ['esperando você', 'pill pill-hold'],
  waiting_task: ['esperando colega', 'pill pill-info'],
  waiting_budget: ['orçamento parado', 'pill pill-stop'],
  waiting_external: ['esperando resposta de fora', 'pill pill-info'],
  in_review: ['em revisão', 'pill pill-hold'],
  done: ['concluída', 'pill pill-go'],
  failed: ['falhou', 'pill pill-stop'],
  cancelled: ['cancelada', 'pill'],
  expired: ['expirou', 'pill']
}
const STEP_MARK: Record<string, string> = { done: '✓', doing: '◐', skipped: '–', todo: '' }

const isDone = (s: string): boolean => (TASK_DONE as readonly string[]).includes(s)
const time = (iso: string): string =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
const size = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

const amount = (n: number, unit: string): string =>
  `${Number.isInteger(n) ? n : n.toFixed(1)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`
const duration = (secs: number): string =>
  secs < 60 ? `${secs} s` : secs < 3600 ? `${Math.round(secs / 60)} min` : `${(secs / 3600).toFixed(1)} h`

/** The employee's long jobs (download, scoring…): a bar, how far it got and when it should end. */
function Jobs({ t }: { t: FollowedTask }) {
  if (!t.jobs.length) return null
  return (
    <div className={styles.followSection} data-follow-jobs>
      {t.jobs.map((j) => {
        const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : undefined
        const ends = j.state === 'running' && j.etaS !== undefined && j.at ? Date.parse(j.at) + j.etaS * 1000 : undefined
        const took = j.state !== 'running' && j.started && j.at ? (Date.parse(j.at) - Date.parse(j.started)) / 1000 : 0
        return (
          <div key={j.id} className={styles.followJob} data-job={j.id} data-job-state={j.state}>
            <div className={styles.followJobHead}>
              <span title={j.label}>{j.label || 'Trabalho longo'}</span>
              <span className="muted">
                {j.state === 'done'
                  ? `✓ concluído${took >= 1 ? ` em ${duration(Math.round(took))}` : ''}`
                  : j.state === 'failed'
                    ? 'parou com erro'
                    : `${amount(j.done, j.unit)}${j.total && j.unit !== '%' ? ` de ${amount(j.total, j.unit)}` : ''}` +
                      (pct !== undefined && j.unit !== '%' ? ` · ${pct}%` : '') +
                      (ends ? ` · fim previsto às ${time(new Date(ends).toISOString())} (~${duration(j.etaS ?? 0)})` : '')}
              </span>
            </div>
            {pct !== undefined && (
              <span className={styles.followProgress} data-wide>
                <span style={{ width: `${j.state === 'done' ? 100 : pct}%` }} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The task's files (open, or show in the folder) and the links of its result. */
function Deliverables({ t }: { t: FollowedTask }) {
  const [busy, setBusy] = useState<number>()
  const [error, setError] = useState<string>()
  if (!t.files.length && !t.links.length) return null
  const open = async (f: TaskFile, reveal: boolean) => {
    setBusy(f.id)
    setError(undefined)
    try {
      await workspaceApi.openTaskFile(f.id, reveal)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className={styles.followSection} data-follow-deliverables>
      <h4>Entregáveis</h4>
      <ul className={styles.followFiles}>
        {t.files.map((f) => (
          <li key={f.id} data-task-file={f.id}>
            <span title={f.name}>
              {f.name}
              <span className="muted">
                {' '}
                · {f.version > 1 ? `v${f.version} · ` : ''}
                {size(f.size)}
                {f.kind === 'input' ? ' · anexo' : ''}
              </span>
            </span>
            <button className="btn" disabled={busy === f.id} onClick={() => void open(f, false)}>
              {busy === f.id ? 'Baixando…' : 'Abrir'}
            </button>
            <button className="btn" disabled={busy === f.id} onClick={() => void open(f, true)}>
              Pasta
            </button>
          </li>
        ))}
        {t.links.map((url) => (
          <li key={url}>
            <a href={url} target="_blank" rel="noreferrer" title={url}>
              {url.replace(/^https?:\/\//, '')} ↗
            </a>
          </li>
        ))}
      </ul>
      {error && (
        <div className={styles.followProblem} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

function TaskCard({
  t,
  byId,
  renderText,
  depth = 0
}: {
  t: FollowedTask
  byId: Map<number, FollowedTask>
  renderText: (text: string) => ReactNode
  /** How deep inside other cards (a handoff of a handoff…). */
  depth?: number
}) {
  const nested = depth > 0
  const [open, setOpen] = useState(!isDone(t.status))
  const ws = useWorkspace()
  const [label, cls] = STATUS[t.status] ?? [t.status || 'carregando…', 'pill']
  const waiting = (TASK_WAITING as readonly string[]).includes(t.status)
  // The task's open requests the person may decide (still open on the task: one decided elsewhere leaves at once); the
  // rest are only described.
  const decisions = (ws?.decisions.data ?? []).filter(
    (d) => d.taskId === t.id && t.requests.some((r) => r.id === d.id)
  )
  const others = t.requests.filter((r) => !decisions.some((d) => d.id === r.id))
  const kids = t.children.map((c) => (depth < 3 ? byId.get(c.id) : undefined))
  return (
    <div className={`${styles.followCard} ${nested ? styles.followNested : ''}`} data-follow-task={t.id}>
      <button className={styles.followHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={styles.followTitle}>
          #{t.id} · {t.title}
        </span>
        {decisions.length > 0 && <span className="pill pill-hold">decidir ({decisions.length})</span>}
        <span className={cls}>{label}</span>
        {t.progress && (
          <span className={styles.followProgress} title={`${t.progress.done} de ${t.progress.total} etapas`}>
            <span style={{ width: `${t.progress.pct}%` }} />
          </span>
        )}
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className={styles.followBody}>
          <div className={`muted ${styles.small}`}>
            {t.employeeName || 'Digital employee'} · {usd(t.costUsd)}
            {t.tokens ? ` · ${(t.tokens / 1000).toFixed(0)}k tokens` : ''}
            {t.parent && !nested ? ` · repassada da tarefa #${t.parent.id}` : ''}
          </div>
          {t.problem && <div className={styles.followProblem}>{t.problem}</div>}
          {t.steps.length > 0 && (
            <ul className={styles.followSteps}>
              {t.steps.map((s, i) => (
                <li key={i} data-step={s.status}>
                  <span>{STEP_MARK[s.status] ?? ''}</span>
                  {s.title}
                </li>
              ))}
            </ul>
          )}
          {t.lines.length > 0 && (
            <ul className={styles.followLines}>
              {t.lines.map((l, i) => (
                <li key={i}>
                  <span className="muted">{time(l.at)}</span> {l.text}
                </li>
              ))}
            </ul>
          )}
          <Jobs t={t} />
          {decisions.map((d) => (
            <DecisionCard key={d.id} d={d} />
          ))}
          {waiting && others.length > 0 && (
            <div className={styles.followAsk}>
              {others.map((r) => (
                <div key={r.id}>
                  <b>Pedido #{r.id}</b> ({r.kind}): {r.text}
                </div>
              ))}
              <span className="muted">
                Se a decisão for sua, ela aparece aqui para decidir. Se não, fica com quem responde pelo funcionário.
              </span>
            </div>
          )}
          {kids.map((k, i) =>
            k ? (
              <TaskCard key={k.id} t={k} byId={byId} renderText={renderText} depth={depth + 1} />
            ) : (
              <div key={t.children[i].id} className={`muted ${styles.small}`}>
                Repassada: #{t.children[i].id} {t.children[i].title} ({t.children[i].employeeName || 'colega'},{' '}
                {STATUS[t.children[i].status]?.[0] ?? t.children[i].status})
              </div>
            )
          )}
          <Deliverables t={t} />
          {isDone(t.status) && (t.result || t.error) && (
            <div className={styles.followResult}>{t.result ? renderText(t.result) : <span>{t.error}</span>}</div>
          )}
          <div className={styles.followActions}>
            {!nested ? (
              <label className={styles.small}>
                <input
                  type="checkbox"
                  checked={t.wake}
                  onChange={(e) => void workspaceApi.setFollow(t.id, { wake: e.target.checked })}
                />{' '}
                Retomar a conversa quando terminar ou pedir decisão
              </label>
            ) : (
              <span className={styles.small} />
            )}
            <button className="btn" onClick={() => openPortal({ screen: 'task', id: t.id }, t.title)}>
              No portal ↗
            </button>
            {!nested && isDone(t.status) && (
              <button
                className="btn"
                onClick={() => {
                  // the tasks it handed off go with it
                  for (const c of t.children) if (byId.has(c.id)) void workspaceApi.setFollow(c.id, { unfollow: true })
                  void workspaceApi.setFollow(t.id, { unfollow: true })
                }}
              >
                Fechar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** The tasks this session follows; nothing when it follows none. `renderText` draws the result (Markdown). */
export function TaskFollowPanel({
  sessionId,
  renderText
}: {
  sessionId: string
  renderText: (text: string) => ReactNode
}) {
  const tasks = useFollowedTasks((s) => s.bySession[sessionId])
  useEffect(() => loadFollowedTasks(sessionId), [sessionId])
  if (!tasks?.length) return null
  const byId = new Map(tasks.map((t) => [t.id, t]))
  // A task handed off from another one this session follows shows inside that one's card.
  const nestedIds = new Set(tasks.flatMap((t) => t.children.map((c) => c.id)).filter((id) => byId.has(id)))
  return (
    <div className={styles.follow} aria-label="Tarefas acompanhadas">
      {tasks
        .filter((t) => !nestedIds.has(t.id))
        .map((t) => (
          <TaskCard key={t.id} t={t} byId={byId} renderText={renderText} />
        ))}
    </div>
  )
}
