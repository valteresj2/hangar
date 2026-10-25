import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BlindCandidate, LabDeliverable, LabRoundView } from '@shared/features/lab'
import { errorMessage, labApi } from './labApi'
import styles from './lab.module.css'

export function DiffBlock({ text }: { text: string }) {
  return (
    <pre className={styles.diff}>
      {text.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? styles.diffAdd
              : line.startsWith('-') && !line.startsWith('---')
                ? styles.diffDel
                : line.startsWith('@@')
                  ? styles.diffHunk
                  : undefined
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

/** One deliverable: final answer, change summary and (collapsed) diff. */
export function DeliverableCard({
  title,
  d,
  children
}: {
  title: string
  d: LabDeliverable
  children?: React.ReactNode
}) {
  const [showDiff, setShowDiff] = useState(false)
  return (
    <div className={styles.candidate}>
      <div className={styles.candidateHead}>{title}</div>
      <div className={styles.candidateBody}>
        <div className={styles.sectionLabel}>Resposta final</div>
        <div className={styles.markdown}>
          {d.finalAnswer ? (
            <Markdown remarkPlugins={[remarkGfm]}>{d.finalAnswer}</Markdown>
          ) : (
            <em className="muted">Sem resposta final.</em>
          )}
        </div>
        <div className={styles.sectionLabel}>Mudanças</div>
        {d.diffStat ? (
          <pre className={styles.stat}>{d.diffStat}</pre>
        ) : (
          <div className="muted">Nenhum arquivo alterado.</div>
        )}
        {d.diffExcerpt && (
          <>
            <button className={styles.linkBtn} onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? 'Ocultar diff' : `Ver diff${d.diffTruncated ? ' (truncado)' : ''}`}
            </button>
            {showDiff && <DiffBlock text={d.diffExcerpt} />}
          </>
        )}
        {d.errors.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Erros</div>
            <pre className={styles.errorsPre}>{d.errors.join('\n')}</pre>
          </>
        )}
      </div>
      {children}
    </div>
  )
}

/** Anonymous candidates side by side; the user picks one, or asks Claude to. */
export function BlindSelect({ round }: { round: LabRoundView }) {
  const [candidates, setCandidates] = useState<BlindCandidate[]>()
  const [mode, setMode] = useState<'user' | 'claude'>('user')
  const [picked, setPicked] = useState<string>()
  const [why, setWhy] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    labApi.candidates(round.id).then(setCandidates, (e) => setError(errorMessage(e)))
  }, [round.id])

  const confirm = async () => {
    if (!picked) return
    setBusy(true)
    setError(undefined)
    try {
      await labApi.choose(round.id, picked, why)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const ask = async () => {
    setError(undefined)
    try {
      await labApi.askClaude(round.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className={styles.blind}>
      <div className={styles.blindHead}>
        <div>
          <h3 className={styles.h3}>Seleção cega</h3>
          <p className={styles.hint}>
            Os candidatos estão embaralhados e sem rótulo: um deles é a base (harness atual). Manter a base é um
            resultado válido. Compare os entregáveis, não a aparência.
          </p>
        </div>
        <div className={styles.segmented}>
          <button className={mode === 'user' ? styles.segActive : ''} onClick={() => setMode('user')}>
            Você escolhe
          </button>
          <button className={mode === 'claude' ? styles.segActive : ''} onClick={() => setMode('claude')}>
            Pedir ao Claude
          </button>
        </div>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {round.selectionError && <div className={styles.error}>A escolha do Claude falhou: {round.selectionError}</div>}

      {mode === 'claude' && (
        <div className={styles.callout}>
          <p>
            Um Claude sem ferramentas recebe a tarefa e os candidatos anônimos (resposta final + mudanças), sem
            gabarito, e escolhe um com a justificativa. Ele usa o modelo padrão das configurações.
          </p>
          <button
            className="btn btn-primary"
            disabled={round.claudeSelecting || !candidates}
            onClick={() => void ask()}
          >
            {round.claudeSelecting ? 'O Claude está comparando…' : 'Pedir ao Claude para escolher'}
          </button>
        </div>
      )}

      {!candidates ? (
        <div className="muted">Carregando candidatos…</div>
      ) : (
        <div
          className={styles.candidates}
          style={{ gridTemplateColumns: `repeat(${candidates.length}, minmax(320px, 1fr))` }}
        >
          {candidates.map((c) => (
            <DeliverableCard key={c.anonId} title={`Candidato ${c.anonId}`} d={c}>
              {mode === 'user' && (
                <label className={`${styles.pick} ${picked === c.anonId ? styles.pickActive : ''}`}>
                  <input type="radio" name="pick" checked={picked === c.anonId} onChange={() => setPicked(c.anonId)} />
                  Escolher {c.anonId}
                </label>
              )}
            </DeliverableCard>
          ))}
        </div>
      )}

      {mode === 'user' && candidates && (
        <div className={styles.whyBox}>
          <textarea
            className="input"
            rows={2}
            placeholder="Por quê? (o critério que decidiu e o que custou a escolha ao segundo colocado)"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!picked || busy} onClick={() => void confirm()}>
            {picked ? `Confirmar ${picked}` : 'Escolha um candidato'}
          </button>
        </div>
      )}
    </div>
  )
}
