import { useState } from 'react'
import type { PermissionRequest, PermissionResponse, Question, TranscriptEntry } from '@shared/features/engine'
import { DiffView } from './DiffView'
import { SHELL_TOOLS, toolLabel, toolSummary } from './tools'
import styles from './engine.module.css'

type Respond = (requestId: string, response: PermissionResponse) => void
type Decision = Extract<TranscriptEntry, { kind: 'permission_decision' }>

function RequestDetail({ request }: { request: PermissionRequest }) {
  const input = request.input
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  if (SHELL_TOOLS.has(request.toolName)) return <pre className={styles.toolCommand}>{text(input.command)}</pre>
  if (request.toolName === 'Edit')
    return <DiffView before={text(input.old_string)} after={text(input.new_string)} maxHeight={260} />
  if (request.toolName === 'Write') return <DiffView before="" after={text(input.content)} maxHeight={260} />
  if (request.toolName === 'ExitPlanMode' && text(input.plan))
    return <pre className={styles.toolInput}>{text(input.plan)}</pre>
  const summary = toolSummary(request.toolName, input)
  return summary ? <div className={styles.permSummary}>{summary}</div> : null
}

export function PermissionCard({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }) {
  const [denying, setDenying] = useState(false)
  const [message, setMessage] = useState('')
  const title = request.title ?? `Claude quer usar ${toolLabel(request.toolName)}`

  return (
    <div className={styles.permCard}>
      <div className={styles.permTitle}>{title}</div>
      {request.description && <div className="muted">{request.description}</div>}
      <RequestDetail request={request} />
      {request.decisionReason && <div className={styles.permReason}>{request.decisionReason}</div>}
      {request.blockedPath && <div className={styles.permReason}>Caminho: {request.blockedPath}</div>}
      {denying ? (
        <form
          className={styles.permActions}
          onSubmit={(e) => {
            e.preventDefault()
            onRespond(request.requestId, { decision: 'deny', message })
          }}
        >
          <input
            className="input"
            autoFocus
            placeholder="Diga ao Claude o que fazer em vez disso (opcional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button type="submit" className="btn">
            Negar
          </button>
          <button type="button" className="btn" onClick={() => setDenying(false)}>
            Voltar
          </button>
        </form>
      ) : (
        <div className={styles.permActions}>
          <button className="btn btn-primary" onClick={() => onRespond(request.requestId, { decision: 'allow' })}>
            Permitir
          </button>
          {request.canAlwaysAllow && (
            <button className="btn" onClick={() => onRespond(request.requestId, { decision: 'allow_always' })}>
              Permitir sempre nesta sessão
            </button>
          )}
          <button className="btn" onClick={() => setDenying(true)}>
            Negar
          </button>
        </div>
      )}
    </div>
  )
}

const OTHER = '\u0000other'

function QuestionBlock({
  q,
  value,
  onChange
}: {
  q: Question
  value: { picked: string[]; other: string }
  onChange(v: { picked: string[]; other: string }): void
}) {
  const toggle = (label: string) => {
    if (q.multiSelect) {
      const picked = value.picked.includes(label) ? value.picked.filter((l) => l !== label) : [...value.picked, label]
      onChange({ ...value, picked })
    } else {
      onChange({ ...value, picked: [label] })
    }
  }
  return (
    <div className={styles.question}>
      <div className={styles.questionText}>
        {q.header && <span className={styles.chip}>{q.header}</span>} {q.question}
      </div>
      <div className={styles.options}>
        {q.options.map((o) => (
          <button
            key={o.label}
            className={`${styles.option} ${value.picked.includes(o.label) ? styles.optionOn : ''}`}
            onClick={() => toggle(o.label)}
          >
            <span className={styles.optionLabel}>{o.label}</span>
            {o.description && <span className="muted">{o.description}</span>}
          </button>
        ))}
        <button
          className={`${styles.option} ${value.picked.includes(OTHER) ? styles.optionOn : ''}`}
          onClick={() => toggle(OTHER)}
        >
          <span className={styles.optionLabel}>Outra resposta</span>
        </button>
        {value.picked.includes(OTHER) && (
          <input
            className="input"
            autoFocus
            placeholder="Escreva sua resposta"
            value={value.other}
            onChange={(e) => onChange({ ...value, other: e.target.value })}
          />
        )}
      </div>
    </div>
  )
}

export function QuestionCard({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }) {
  const questions = request.questions ?? []
  const [values, setValues] = useState(() => questions.map(() => ({ picked: [] as string[], other: '' })))
  const answerFor = (i: number) =>
    values[i].picked
      .map((p) => (p === OTHER ? values[i].other.trim() : p))
      .filter(Boolean)
      .join(', ')
  const complete = questions.every((_, i) => answerFor(i))

  return (
    <div className={styles.permCard}>
      <div className={styles.permTitle}>Claude tem {questions.length > 1 ? 'algumas perguntas' : 'uma pergunta'}</div>
      {questions.map((q, i) => (
        <QuestionBlock
          key={i}
          q={q}
          value={values[i]}
          onChange={(v) => setValues((all) => all.map((x, j) => (j === i ? v : x)))}
        />
      ))}
      <div className={styles.permActions}>
        <button
          className="btn btn-primary"
          disabled={!complete}
          onClick={() =>
            onRespond(request.requestId, {
              decision: 'allow',
              answers: Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)]))
            })
          }
        >
          Responder
        </button>
        <button className="btn" onClick={() => onRespond(request.requestId, { decision: 'deny' })}>
          Dispensar
        </button>
      </div>
    </div>
  )
}

const DECISION_TEXT: Record<Decision['decision'], string> = {
  allow: 'Permitido',
  allow_always: 'Permitido sempre nesta sessão',
  deny: 'Negado'
}

/** Compact line for a request that is no longer pending. */
export function PermissionSummary({ request, decision }: { request: PermissionRequest; decision?: Decision }) {
  if (request.questions) {
    const answers = decision?.answers
    return (
      <div className={styles.permDone}>
        {decision?.decision === 'deny' || !answers
          ? 'Pergunta dispensada'
          : Object.entries(answers).map(([q, a]) => (
              <div key={q}>
                <span className="muted">{q}</span> → {a}
              </div>
            ))}
      </div>
    )
  }
  return (
    <div className={styles.permDone}>
      <span className={decision?.decision === 'deny' ? styles.diffDelText : styles.diffAddText}>
        {decision ? DECISION_TEXT[decision.decision] : 'Sem resposta'}
      </span>
      : {toolLabel(request.toolName)}
      {decision?.message ? <span className="muted"> — {decision.message}</span> : null}
    </div>
  )
}
