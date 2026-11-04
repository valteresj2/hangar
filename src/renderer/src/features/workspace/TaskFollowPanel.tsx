// The platform tasks this session follows, at the bottom of the session (above the composer): status, the employee's
// plan, the latest steps of the timeline, cost, what waits for a person and, at the end, the full result. Live: main
// pushes each change (task.updated). The session answers on its own when a task ends (turn it off per task).
import { useEffect, useState, type ReactNode } from 'react'
import { TASK_DONE, TASK_WAITING, type FollowedTask } from '@shared/features/workspace'
import { loadFollowedTasks, openPortal, useFollowedTasks, workspaceApi } from './api'
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

function TaskCard({ t, renderText }: { t: FollowedTask; renderText: (text: string) => ReactNode }) {
  const [open, setOpen] = useState(!isDone(t.status))
  const [label, cls] = STATUS[t.status] ?? [t.status || 'carregando…', 'pill']
  const waiting = (TASK_WAITING as readonly string[]).includes(t.status)
  return (
    <div className={styles.followCard} data-follow-task={t.id}>
      <button className={styles.followHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={styles.followTitle}>
          #{t.id} · {t.title}
        </span>
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
            {t.parent ? ` · repassada da tarefa #${t.parent.id}` : ''}
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
          {waiting && t.requests.length > 0 && (
            <div className={styles.followAsk}>
              {t.requests.map((r) => (
                <div key={r.id}>
                  <b>Pedido #{r.id}</b> ({r.kind}): {r.text}
                </div>
              ))}
              <span className="muted">A decisão fica em Decisões, no app.</span>
            </div>
          )}
          {t.children.length > 0 && (
            <div className={`muted ${styles.small}`}>
              Repassadas:{' '}
              {t.children
                .map((c) => `#${c.id} ${c.title} (${c.employeeName || 'colega'}, ${STATUS[c.status]?.[0] ?? c.status})`)
                .join(' · ')}
            </div>
          )}
          {isDone(t.status) && (t.result || t.error) && (
            <div className={styles.followResult}>{t.result ? renderText(t.result) : <span>{t.error}</span>}</div>
          )}
          <div className={styles.followActions}>
            <label className={styles.small}>
              <input
                type="checkbox"
                checked={t.wake}
                onChange={(e) => void workspaceApi.setFollow(t.id, { wake: e.target.checked })}
              />{' '}
              Retomar a conversa quando terminar ou pedir decisão
            </label>
            <button className="btn" onClick={() => openPortal({ screen: 'task', id: t.id }, t.title)}>
              No portal ↗
            </button>
            {isDone(t.status) && (
              <button className="btn" onClick={() => void workspaceApi.setFollow(t.id, { unfollow: true })}>
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
  return (
    <div className={styles.follow} aria-label="Tarefas acompanhadas">
      {tasks.map((t) => (
        <TaskCard key={t.id} t={t} renderText={renderText} />
      ))}
    </div>
  )
}
