import { useState } from 'react'
import type { Session } from '@shared/contracts'
import type { ReflectResult } from '@shared/harness'
import { BASE_VARIANT_ID, type LabRoundView, type LabVariantView } from '@shared/features/lab'
import { useCollection } from '../../core/data'
import { BlindSelect, DeliverableCard } from './BlindSelect'
import { errorMessage, formatCost, formatDate, formatDuration, labApi, useTicker } from './labApi'
import styles from './lab.module.css'

export const ROUND_STATUS: Record<LabRoundView['status'], string> = {
  preparing: 'Preparando',
  running: 'Rodando',
  selecting: 'Seleção cega',
  decided: 'Decidida',
  failed: 'Falhou',
  cancelled: 'Cancelada'
}

const MODE_LABEL: Record<string, string> = {
  default: 'perguntar sempre',
  acceptEdits: 'aceitar edições',
  plan: 'plano',
  auto: 'automático',
  bypassPermissions: 'ignorar permissões'
}

function variantStatus(v: LabVariantView, session?: Session): { text: string; cls?: string } {
  if (v.status === 'running' && session?.status === 'waiting') return { text: 'Aguardando você', cls: styles.stWaiting }
  if (v.status === 'running') return { text: 'Rodando', cls: styles.stRunning }
  if (v.status === 'done') return { text: 'Concluída', cls: styles.stDone }
  if (v.status === 'error') return { text: 'Erro', cls: styles.stError }
  return { text: 'Pendente' }
}

function Progress({ round, onOpenSession }: { round: LabRoundView; onOpenSession(id: string): void }) {
  const sessions = useCollection('sessions')
  const active = round.status === 'running' || round.status === 'preparing'
  const now = useTicker(active)
  return (
    <div className={styles.progress}>
      {round.variants.map((v) => {
        const session = v.sessionId ? sessions.find((s) => s.id === v.sessionId) : undefined
        const st = variantStatus(v, session)
        const elapsed = v.durationMs ?? (v.startedAt ? (v.finishedAt ?? now) - v.startedAt : undefined)
        return (
          <div key={v.id} className={`${styles.progressRow} ${st.cls === styles.stWaiting ? styles.progressWaiting : ''}`}>
            <span className={styles.progressLabel}>{v.label}</span>
            <span className={`${styles.badge} ${st.cls ?? ''}`}>{st.text}</span>
            <span className={styles.metric}>{formatDuration(elapsed)}</span>
            <span className={styles.metric}>{formatCost(v.costUsd)}</span>
            {v.sessionId && session ? (
              <button className="btn" onClick={() => onOpenSession(v.sessionId!)}>
                Abrir sessão
              </button>
            ) : (
              <span />
            )}
            {v.error && <div className={styles.progressError}>{v.error}</div>}
          </div>
        )
      })}
    </div>
  )
}

function Reflection({ result }: { result: ReflectResult }) {
  const { reflection, lesson } = result
  return (
    <div className={styles.reflection}>
      <h4 className={styles.h4}>O que cada edição fez</h4>
      {reflection.edits.length === 0 ? (
        <div className="muted">Nenhuma linha de edição.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Componente</th>
              <th>Candidatos</th>
              <th>Mudança</th>
              <th>Observado</th>
              <th>Veredito</th>
            </tr>
          </thead>
          <tbody>
            {reflection.edits.map((e, i) => (
              <tr key={i}>
                <td>{e.component}</td>
                <td>{e.candidates}</td>
                <td>{e.change}</td>
                <td>{e.observed}</td>
                <td>{e.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className={styles.h4}>Lição</h4>
      {lesson ? (
        <div className={styles.lesson}>
          <div>
            <strong>Quando</strong> {lesson.cue}
          </div>
          <div>
            <strong>Fazer</strong> {lesson.lesson}
          </div>
          <div className="muted">
            Evidência: {lesson.evidence} · confiança {lesson.confidence}
          </div>
        </div>
      ) : (
        <div className="muted">Sem lição transferível (NO_ENTRY).</div>
      )}
    </div>
  )
}

function Reveal({ round }: { round: LabRoundView }) {
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [askApply, setAskApply] = useState(false)
  const winner = round.variants.find((v) => v.id === round.selection?.variantId)
  const anonOf = Object.fromEntries(Object.entries(round.blindMap ?? {}).map(([a, v]) => [v, a]))
  const baseWon = winner?.id === BASE_VARIANT_ID

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(undefined)
    }
  }

  const adopt = (apply: boolean) =>
    run('adopt', async () => {
      setAskApply(false)
      const res = await labApi.adopt(round.id, apply)
      setNotice(
        res.unchanged
          ? 'A base venceu: nada muda no projeto.'
          : res.applied
            ? `Snapshot "${res.snapshot?.label}" criado e harness aplicado no projeto.`
            : `Snapshot "${res.snapshot?.label}" criado. O projeto não foi alterado.`
      )
    })

  return (
    <div className={styles.reveal}>
      <div className={`${styles.winner} ${baseWon ? styles.winnerBase : ''}`}>
        <div className={styles.winnerTitle}>
          Vencedor: Candidato {round.selection?.anonId} = <strong>{winner?.label}</strong>
          <span className="muted"> · escolhido por {round.selection?.by === 'claude' ? 'Claude' : 'você'}</span>
        </div>
        {round.selection?.why && <div className={styles.why}>{round.selection.why}</div>}
        {baseWon && <div>A base venceu: o harness atual continua e nada muda no projeto.</div>}
        {round.selectionCostUsd !== undefined && <div className="muted">Custo da seleção: {formatCost(round.selectionCostUsd)}</div>}
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Candidato</th>
            <th>Variante</th>
            <th>Status</th>
            <th>Custo</th>
            <th>Tempo</th>
          </tr>
        </thead>
        <tbody>
          {round.variants.map((v) => (
            <tr key={v.id} className={v.id === winner?.id ? styles.rowWinner : undefined}>
              <td>{anonOf[v.id] ?? '—'}</td>
              <td>
                {v.label}
                {v.id === BASE_VARIANT_ID && <span className={styles.baseTag}>base</span>}
              </td>
              <td>{v.status === 'done' ? 'Concluída' : v.status === 'error' ? `Erro: ${v.error ?? ''}` : v.status}</td>
              <td>{formatCost(v.costUsd)}</td>
              <td>{formatDuration(v.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      <div className={styles.actions}>
        {askApply ? (
          <div className={styles.callout}>
            <p>
              Criar um snapshot com o harness de <strong>{winner?.label}</strong> e aplicá-lo agora no projeto? Os arquivos
              de harness do projeto (CLAUDE.md, .claude/…) passam a ser os da variante vencedora.
            </p>
            <div className={styles.actions}>
              <button className="btn btn-primary" disabled={!!busy} onClick={() => void adopt(true)}>
                Criar snapshot e aplicar
              </button>
              <button className="btn" disabled={!!busy} onClick={() => void adopt(false)}>
                Só criar o snapshot
              </button>
              <button className="btn" onClick={() => setAskApply(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!!busy || baseWon || !!round.adoptedSnapshotId}
            title={baseWon ? 'A base venceu: nada a adotar' : round.adoptedSnapshotId ? 'Já adotado' : undefined}
            onClick={() => setAskApply(true)}
          >
            {round.adoptedSnapshotId ? (round.applied ? 'Adotado e aplicado' : 'Snapshot criado') : 'Adotar harness vencedor'}
          </button>
        )}
        <button
          className="btn"
          disabled={!!busy}
          onClick={() =>
            void run('reflect', async () => {
              await labApi.reflect(round.id)
            })
          }
        >
          {busy === 'reflect' ? 'Refletindo…' : round.reflection ? 'Refletir de novo' : 'Refletir sobre a rodada'}
        </button>
      </div>

      {round.reflection && <Reflection result={round.reflection} />}

      <h3 className={styles.h3}>Entregáveis revelados</h3>
      <div
        className={styles.candidates}
        style={{ gridTemplateColumns: `repeat(${round.variants.filter((v) => v.deliverable).length || 1}, minmax(320px, 1fr))` }}
      >
        {round.variants
          .filter((v) => v.deliverable)
          .map((v) => (
            <DeliverableCard
              key={v.id}
              title={`${anonOf[v.id] ? `${anonOf[v.id]} · ` : ''}${v.label}${v.id === winner?.id ? ' ★' : ''}`}
              d={v.deliverable!}
            />
          ))}
      </div>
    </div>
  )
}

export function RoundDetail({ round, onOpenSession }: { round: LabRoundView; onOpenSession(id: string): void }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const active = round.status === 'preparing' || round.status === 'running'
  const hasWorktrees = round.variants.some((v) => v.worktree)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(undefined)
    }
  }

  const cleanup = () => {
    const ok = window.confirm(
      'Limpar a rodada? Os worktrees das variantes são removidos (alterações não commitadas neles se perdem) e as sessões da rodada são arquivadas.'
    )
    if (ok) void run('cleanup', () => labApi.cleanup(round.id))
  }

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={`${styles.badge} ${styles[`round_${round.status}`] ?? ''}`}>{ROUND_STATUS[round.status]}</span>
        <span className="muted">
          {formatDate(round.createdAt)} · modelo {round.model ?? 'padrão'} · {MODE_LABEL[round.permissionMode] ?? round.permissionMode}
        </span>
      </div>
      <div className={styles.task}>{round.task}</div>
      {round.error && <div className={styles.error}>{round.error}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {round.status !== 'selecting' && round.status !== 'decided' && <Progress round={round} onOpenSession={onOpenSession} />}
      {active && (
        <p className={styles.hint}>
          Cada variante roda numa sessão própria (grupo “Harness Lab”). Pedidos de permissão param a variante até você
          responder em “Abrir sessão”.
        </p>
      )}
      {round.status === 'selecting' && <BlindSelect round={round} />}
      {round.status === 'decided' && <Reveal round={round} />}

      <div className={styles.footer}>
        {active ? (
          <button className="btn" disabled={!!busy} onClick={() => void run('cancel', () => labApi.cancel(round.id))}>
            {busy === 'cancel' ? 'Cancelando…' : 'Cancelar rodada'}
          </button>
        ) : (
          <>
            {round.status === 'decided' &&
              round.variants.map(
                (v) =>
                  v.sessionId && (
                    <button key={v.id} className="btn" onClick={() => onOpenSession(v.sessionId!)}>
                      Sessão: {v.label}
                    </button>
                  )
              )}
            <div className={styles.spacer} />
            {round.cleanupErrors && <span className={styles.warnText}>Falhas na limpeza: {round.cleanupErrors.join('; ')}</span>}
            {hasWorktrees && !round.cleanedUp ? (
              <button className="btn" disabled={!!busy} onClick={cleanup}>
                {busy === 'cleanup' ? 'Limpando…' : 'Limpar worktrees e sessões'}
              </button>
            ) : (
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => {
                  if (window.confirm('Excluir esta rodada do histórico do Lab?')) void run('remove', () => labApi.remove(round.id))
                }}
              >
                Excluir rodada
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
