// Decisões: the open requests the person may decide (GET /api/decisions), decided right here (POST
// /api/decisions/{id}). Kinds with more to them than a choice and a comment (capability, shadow reviews, edited
// plans…) keep the portal one click away.
import { useState } from 'react'
import type { WorkspaceDecision, WorkspaceState } from '@shared/features/workspace'
import { openPortal, workspaceApi } from './api'
import { ago, DECISION_KIND, when } from './format'
import { LiveNote, LoadState } from './WorkspaceView'
import styles from './workspace.module.css'

interface Choice {
  decision: string
  label: string
  primary?: boolean
  /** The comment is required for this choice (and says what it is for). */
  needs?: string
}

/** The choices of each kind the app decides; the rest go to the portal. */
export function choicesOf(kind: string): Choice[] | undefined {
  switch (kind) {
    case 'notice':
      return [{ decision: 'ack', label: 'Ciente', primary: true }]
    case 'question':
      return [{ decision: 'answer', label: 'Responder', primary: true, needs: 'Escreva a resposta.' }]
    case 'admission':
      return [
        { decision: 'approve', label: 'Admitir', primary: true },
        { decision: 'reject', label: 'Recusar' }
      ]
    case 'review':
      return [
        { decision: 'approve', label: 'Aprovar o resultado', primary: true },
        { decision: 'reject', label: 'Pedir mudanças', needs: 'Diga o que mudar.' }
      ]
    case 'plan':
      return [
        { decision: 'approve', label: 'Aprovar o plano', primary: true },
        { decision: 'instruct', label: 'Instruir', needs: 'Diga o que mudar no plano.' },
        { decision: 'reject', label: 'Recusar', needs: 'Diga por que recusa.' }
      ]
    case 'approval':
      return [
        { decision: 'approve', label: 'Aprovar', primary: true },
        { decision: 'instruct', label: 'Instruir', needs: 'Diga o que ele deve fazer em vez disso.' },
        { decision: 'reject', label: 'Recusar' }
      ]
    default:
      return undefined
  }
}

const RISK: Record<string, string> = { low: 'risco baixo', medium: 'risco médio', high: 'risco alto' }

function DecisionCard({ d }: { d: WorkspaceDecision }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()
  const choices = choicesOf(d.kind)
  const title = d.question ?? d.taskTitle ?? DECISION_KIND[d.kind] ?? d.kind

  const decide = async (c: Choice) => {
    if (c.needs && !reason.trim()) {
      setError(c.needs)
      return
    }
    setBusy(c.decision)
    setError(undefined)
    try {
      const out = await workspaceApi.decide({ id: d.id, decision: c.decision, reason: reason.trim() })
      setDone(out.message ?? `${c.label}: feito.`)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err)
      )
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className={`${styles.card} ${styles.decisionCard}`} data-decision={d.id}>
      <div className={styles.decisionHead}>
        <span>
          <b>{d.employeeName || 'Agente'}</b>
          {d.employeeTitle && <span className="muted"> · {d.employeeTitle}</span>}
        </span>
        <span className="pill">{DECISION_KIND[d.kind] ?? d.kind}</span>
        {!d.mine && <span className="pill">como substituto</span>}
        {d.risk && <span className={d.risk === 'high' ? 'pill pill-stop' : 'pill'}>{RISK[d.risk] ?? d.risk}</span>}
        <span className={`muted ${styles.small}`}>
          {ago(d.createdAt)}
          {d.expiresAt ? ` · prazo ${when(d.expiresAt)}` : ''}
        </span>
      </div>
      <div className={styles.decisionTitle}>{title}</div>
      {d.question && d.taskTitle && <div className={`muted ${styles.small}`}>Tarefa: {d.taskTitle}</div>}
      {d.rationale && <p className={styles.decisionText}>{d.rationale}</p>}
      {(d.tool || d.payload) && (
        // A short action (a terminal command, a file to publish) shows open: approving it means reading it.
        <details className={styles.payload} open={!!d.payload && d.payload.length <= 600}>
          <summary>Ação: {d.tool ?? 'detalhes'}</summary>
          {d.payload && <pre>{d.payload}</pre>}
        </details>
      )}
      {d.approvalsNeeded > 1 && (
        <div className={`muted ${styles.small}`}>
          Aprovações: {d.approvals} de {d.approvalsNeeded}
        </div>
      )}
      {done ? (
        <div className={styles.decisionDone} role="status">
          {done}
        </div>
      ) : choices ? (
        <>
          <textarea
            className={`input ${styles.reason}`}
            aria-label={`Comentário da decisão ${d.id}`}
            placeholder={d.kind === 'question' ? 'Sua resposta' : 'Comentário (opcional na maioria das opções)'}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <div className={styles.decisionError} role="alert">
              {error}
            </div>
          )}
          <div className={styles.decisionActions}>
            {choices.map((c) => (
              <button
                key={c.decision}
                className={c.primary ? 'btn btn-primary' : 'btn'}
                disabled={!!busy}
                onClick={() => void decide(c)}
              >
                {busy === c.decision ? 'Enviando…' : c.label}
              </button>
            ))}
            <button className="btn" onClick={() => openPortal({ screen: 'decision', id: d.id })}>
              No portal ↗
            </button>
          </div>
        </>
      ) : (
        <div className={styles.decisionActions}>
          <span className={`muted ${styles.small}`}>Este tipo de decisão ainda é tomado no portal.</span>
          <button className="btn btn-primary" onClick={() => openPortal({ screen: 'decision', id: d.id })}>
            Decidir no portal ↗
          </button>
        </div>
      )}
    </div>
  )
}

export function DecisionsView({ state }: { state: WorkspaceState }) {
  const list = state.decisions.data ?? []
  const toDecide = list.filter((d) => d.kind !== 'notice')
  const notices = list.filter((d) => d.kind === 'notice')
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.h1}>Decisões</h1>
          <div className={styles.sub}>
            O que os seus Digital employees pedem para você decidir · <LiveNote state={state} />
          </div>
        </div>
        <div className={styles.headActions}>
          <button className="btn" onClick={() => openPortal({ screen: 'decisions' })}>
            Abrir no portal ↗
          </button>
        </div>
      </div>
      <LoadState parts={[state.decisions]} scope="badges">
        {list.length === 0 && <div className={`${styles.card} muted`}>Nada para decidir agora.</div>}
        {toDecide.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
        {notices.length > 0 && (
          <section className={styles.group}>
            <h2 className={styles.groupTitle}>
              Avisos <span className="muted">({notices.length})</span>
            </h2>
            {notices.map((d) => (
              <DecisionCard key={d.id} d={d} />
            ))}
          </section>
        )}
      </LoadState>
    </div>
  )
}
