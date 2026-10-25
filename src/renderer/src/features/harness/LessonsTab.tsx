// Lessons of the project + "Refletir sobre esta sessão" (edit table and a proposed lesson to save or discard).
import { useEffect, useState } from 'react'
import type { Session } from '@shared/contracts'
import type { EditVerdict, Lesson, LessonConfidence } from '@shared/harness'
import { useCollection } from '../../core/data'
import { errorText, formatDate, harnessApi, useLessons, useReflect } from './api'
import { Confirm, ErrorLine } from './ui'
import styles from './harness.module.css'

const CONFIDENCE_LABEL: Record<LessonConfidence, string> = { high: 'alta', medium: 'média', low: 'baixa' }
const VERDICT_LABEL: Record<EditVerdict, string> = {
  helped: 'ajudou',
  hurt: 'atrapalhou',
  'no observed effect': 'sem efeito observado',
  confounded: 'inconclusivo'
}
const REFLECT_MODELS = [
  { value: '', label: 'Modelo padrão' },
  { value: 'haiku', label: 'haiku' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' }
]

type Draft = Pick<Lesson, 'cue' | 'lesson' | 'evidence' | 'confidence'>

function LessonForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel
}: {
  initial: Draft
  onSubmit: (d: Draft) => Promise<void>
  onCancel: () => void
  submitLabel: string
}) {
  const [d, setD] = useState(initial)
  const [busy, setBusy] = useState(false)
  const valid = d.cue.trim() && d.lesson.trim()
  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span>Quando (a forma da situação)</span>
        <textarea
          className={`input ${styles.textareaSm}`}
          rows={2}
          value={d.cue}
          onChange={(e) => setD({ ...d, cue: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>Fazer o quê (nomeando o componente)</span>
        <textarea
          className={`input ${styles.textareaSm}`}
          rows={3}
          value={d.lesson}
          onChange={(e) => setD({ ...d, lesson: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>Evidência</span>
        <textarea
          className={`input ${styles.textareaSm}`}
          rows={3}
          value={d.evidence}
          onChange={(e) => setD({ ...d, evidence: e.target.value })}
        />
      </label>
      <div className={styles.formRow}>
        <label className={styles.fieldInline}>
          Confiança
          <select
            className={`input ${styles.selectInline}`}
            value={d.confidence}
            onChange={(e) => setD({ ...d, confidence: e.target.value as LessonConfidence })}
          >
            {(['high', 'medium', 'low'] as const).map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.spacer} />
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button
          className="btn btn-primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onSubmit(d)
            } finally {
              setBusy(false)
            }
          }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

function ReflectBox({ session, project }: { session: Session; project: string }) {
  const entry = useReflect((s) => s.bySession[session.id])
  const { start, discard, markSaved } = useReflect.getState()
  const [model, setModel] = useState('')
  const [error, setError] = useState<string>()
  const [started, setStarted] = useState<number>()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!entry?.running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [entry?.running])

  const proposal = entry?.proposal
  const working = session.status === 'working'

  return (
    <div className={styles.reflect}>
      <div className={styles.formRow}>
        <button
          className="btn btn-primary"
          disabled={entry?.running || working}
          title={
            working
              ? 'Espere a sessão terminar a rodada atual'
              : 'Lê a trajetória desta sessão e propõe no máximo uma lição'
          }
          onClick={() => {
            setStarted(Date.now())
            void start(session.id, model ? { model } : undefined)
          }}
        >
          {entry?.running ? 'Refletindo…' : 'Refletir sobre esta sessão'}
        </button>
        <select
          className={`input ${styles.selectInline}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Modelo do refletor"
        >
          {REFLECT_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {entry?.running && started && <span className="muted">{Math.round((now - started) / 1000)} s</span>}
      </div>
      <ErrorLine
        text={entry?.error ?? error}
        onClose={() => (entry?.error ? discard(session.id) : setError(undefined))}
      />

      {proposal && (
        <div className={styles.proposal}>
          <div className={styles.meta}>
            Base:{' '}
            {proposal.baseSnapshot
              ? `snapshot “${proposal.baseSnapshot.label}” (${formatDate(proposal.baseSnapshot.createdAt)})`
              : 'harness atual (nenhum snapshot anterior à sessão)'}
          </div>
          <div className={styles.sectionLabel}>O que cada edição fez</div>
          {proposal.reflection.edits.length === 0 ? (
            <div className={styles.emptySm}>Nenhum componente mudou em relação à base.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Componente</th>
                    <th>Mudança</th>
                    <th>Observado</th>
                    <th>Veredito</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.reflection.edits.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <code>{r.component}</code>
                      </td>
                      <td>{r.change}</td>
                      <td>{r.observed}</td>
                      <td>
                        <span className={`${styles.badge} ${styles[`v_${r.verdict.replace(/ /g, '_')}`] ?? ''}`}>
                          {VERDICT_LABEL[r.verdict]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={styles.sectionLabel}>Lição proposta</div>
          {entry?.savedLessonId ? (
            <div className={styles.notice}>
              Lição salva e ativa: ela entra no prompt das próximas sessões deste projeto.
            </div>
          ) : proposal.lesson ? (
            <LessonForm
              initial={proposal.lesson}
              submitLabel="Salvar lição"
              onCancel={() => discard(session.id)}
              onSubmit={async (d) => {
                try {
                  const saved = await harnessApi.saveLesson(
                    { ...proposal.lesson!, ...d, projectCwd: project },
                    proposal.reflection.id
                  )
                  markSaved(session.id, saved.id)
                } catch (err) {
                  setError(errorText(err))
                }
              }}
            />
          ) : (
            <div className={styles.emptySm}>
              NO_ENTRY — o refletor não encontrou um contraste concreto e reutilizável nesta sessão. A tabela de edições
              foi registrada.
            </div>
          )}
          <details className={styles.raw}>
            <summary>Resposta bruta do refletor</summary>
            <pre>{proposal.raw}</pre>
          </details>
          {(entry?.savedLessonId || !proposal.lesson) && (
            <button className="btn" onClick={() => discard(session.id)}>
              Fechar
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function sourceText(l: Lesson, titles: Map<string, string>): string {
  if (l.source.kind === 'session') return `sessão “${titles.get(l.source.sessionId) ?? 'excluída'}”`
  if (l.source.kind === 'lab') return 'rodada do Lab'
  return 'manual'
}

export function LessonsTab({ session, project }: { session: Session; project: string }) {
  const { data: lessons, error: loadError } = useLessons(project)
  const sessions = useCollection('sessions')
  const titles = new Map(sessions.map((s) => [s.id, s.title]))
  const [editing, setEditing] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Lesson>()
  const [error, setError] = useState<string>()

  const update = (id: string, patch: Partial<Lesson>) =>
    harnessApi.updateLesson(project, id, patch).catch((err) => setError(errorText(err)))
  const active = lessons?.filter((l) => l.enabled).length ?? 0

  return (
    <div className={`${styles.tabBody} ${styles.scrollAll}`}>
      <ReflectBox session={session} project={project} />
      <ErrorLine text={error ?? loadError} onClose={() => setError(undefined)} />

      <div className={styles.listHead}>
        <span className={styles.sectionLabel}>
          Lições do projeto {lessons ? `· ${active} ativa${active === 1 ? '' : 's'}` : ''}
        </span>
        <div className={styles.spacer} />
        {!adding && (
          <button className="btn" onClick={() => setAdding(true)}>
            Nova lição
          </button>
        )}
      </div>
      <div className={styles.hint}>
        As lições ativas (até 8) entram no prompt de sistema de toda sessão nova deste projeto, como hipóteses a
        verificar.
      </div>

      <div className={styles.stack}>
        {adding && (
          <div className={styles.card}>
            <LessonForm
              initial={{ cue: '', lesson: '', evidence: '', confidence: 'medium' }}
              submitLabel="Adicionar"
              onCancel={() => setAdding(false)}
              onSubmit={async (d) => {
                try {
                  await harnessApi.saveLesson({
                    ...d,
                    id: '',
                    projectCwd: project,
                    createdAt: 0,
                    enabled: true,
                    source: { kind: 'manual' }
                  })
                  setAdding(false)
                } catch (err) {
                  setError(errorText(err))
                }
              }}
            />
          </div>
        )}
        {lessons && lessons.length === 0 && !adding && <div className={styles.empty}>Nenhuma lição ainda.</div>}
        {lessons?.map((l) => (
          <div key={l.id} className={`${styles.card} ${l.enabled ? '' : styles.cardOff}`}>
            {editing === l.id ? (
              <LessonForm
                initial={l}
                submitLabel="Salvar"
                onCancel={() => setEditing(undefined)}
                onSubmit={async (d) => {
                  await update(l.id, d)
                  setEditing(undefined)
                }}
              />
            ) : (
              <>
                <div className={styles.cardHead}>
                  <label className={styles.toggle} title={l.enabled ? 'Ativa: entra no prompt' : 'Desativada'}>
                    <input
                      type="checkbox"
                      checked={l.enabled}
                      onChange={(e) => void update(l.id, { enabled: e.target.checked })}
                    />
                  </label>
                  <div className={styles.cardMain}>
                    <div className={styles.lessonText}>
                      <span className={styles.cue}>Quando {l.cue.replace(/^(when|quando)\s+/i, '')}</span>
                      <span className={styles.arrow}> → </span>
                      {l.lesson}
                    </div>
                    <div className={styles.meta}>
                      <span className={`${styles.badge} ${styles[`c_${l.confidence}`]}`}>
                        confiança {CONFIDENCE_LABEL[l.confidence]}
                      </span>
                      <span>{sourceText(l, titles)}</span>
                      <span>{formatDate(l.createdAt)}</span>
                    </div>
                    {l.evidence && (
                      <details className={styles.evidence}>
                        <summary>Evidência</summary>
                        <div>{l.evidence}</div>
                      </details>
                    )}
                  </div>
                  <div className={styles.cardActions}>
                    <button className="btn" onClick={() => setEditing(l.id)}>
                      Editar
                    </button>
                    <button className="icon-btn" title="Excluir lição" onClick={() => setConfirmDelete(l)}>
                      ✕
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {confirmDelete && (
        <Confirm
          title="Excluir lição"
          message="Excluir esta lição? Para só tirá-la do prompt, desative em vez de excluir."
          confirm="Excluir"
          danger
          onConfirm={() => harnessApi.deleteLesson(project, confirmDelete.id).catch((err) => setError(errorText(err)))}
          onClose={() => setConfirmDelete(undefined)}
        />
      )}
    </div>
  )
}
