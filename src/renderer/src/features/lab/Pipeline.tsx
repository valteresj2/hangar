import { useState } from 'react'
import { createTwoFilesPatch } from 'diff'
import type { HarnessTree, LabStage } from '@shared/harness'
import type { LabPhaseView, LabRoundView } from '@shared/features/lab'
import { DiffBlock } from './BlindSelect'
import { formatCost, formatDuration } from './labApi'
import { treeChanges } from './treeDiff'
import styles from './lab.module.css'

const PHASE_STATUS: Record<LabPhaseView['status'], string> = {
  pending: 'Aguardando',
  running: 'Em andamento',
  done: 'Concluída',
  error: 'Erro'
}

const STATUS_CLASS: Record<LabPhaseView['status'], string | undefined> = {
  pending: undefined,
  running: styles.stRunning,
  done: styles.stDone,
  error: styles.stError
}

/** Base → proposals → runs → composition → run → blind selection, aggregated per phase. */
export function PipelineTimeline({ phases }: { phases: LabPhaseView[] }) {
  return (
    <ol className={styles.timeline}>
      {phases.map((p) => (
        <li key={p.key} className={`${styles.phase} ${p.status === 'running' ? styles.phaseActive : ''}`}>
          <span className={`${styles.dot} ${STATUS_CLASS[p.status] ?? ''}`} />
          <div className={styles.phaseBody}>
            <div className={styles.phaseTitle}>
              {p.title}
              <span className={`${styles.badge} ${STATUS_CLASS[p.status] ?? ''}`}>{PHASE_STATUS[p.status]}</span>
            </div>
            <div className={styles.phaseMeta}>
              {p.key !== 'select' && (
                <span>
                  {p.finished}/{p.total}
                </span>
              )}
              {p.costUsd !== undefined && <span>{formatCost(p.costUsd)}</span>}
              {p.durationMs !== undefined && <span>{formatDuration(p.durationMs)}</span>}
              {!!p.retries && <span className={styles.warnText}>{p.retries} com nova tentativa</span>}
              {!!p.fallbacks && <span className={styles.warnText}>{p.fallbacks} herdou o harness atual</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

const DIM_LABEL: Record<LabStage['dim'], string> = { INV: 'INV · como o agente trabalha', DOM: 'DOM · o que um especialista sabe', COMPOSE: 'Compositor' }

function stageTitle(s: LabStage): string {
  if (s.dim === 'COMPOSE') return s.step ? `Checkpoint ${s.step}` : 'Composição'
  return `${s.dim} ${s.step ? `· passo ${s.step}` : s.id.replace(/\D/g, '')}`
}

function TreeDiff({ base, tree }: { base: HarnessTree; tree: HarnessTree }) {
  const [open, setOpen] = useState<string>()
  const changes = treeChanges(base, tree)
  if (!changes.length) return <div className="muted">Igual à base.</div>
  return (
    <div className={styles.treeDiff}>
      <div className={styles.diffSummary}>
        {changes.map((c) => (
          <button key={c.path} className={styles.diffChip} onClick={() => setOpen(open === c.path ? undefined : c.path)}>
            <span className={styles[c.kind]}>{c.kind === 'added' ? 'novo' : c.kind === 'removed' ? 'removido' : 'alterado'}</span> {c.path}{' '}
            <span className={styles.plus}>+{c.added}</span> <span className={styles.minus}>−{c.removed}</span>
          </button>
        ))}
      </div>
      {open && <DiffBlock text={createTwoFilesPatch(`base/${open}`, open, base[open] ?? '', tree[open] ?? '', '', '', { context: 3 })} />}
    </div>
  )
}

/** After the decision: what each proposer/composer did, with its notes and its harness diff against the base. */
export function StagesReveal({ round, baseTree }: { round: LabRoundView; baseTree: HarnessTree }) {
  const stages = round.stages ?? []
  if (!stages.length) return null
  const anonOf = Object.fromEntries(Object.entries(round.blindMap ?? {}).map(([a, v]) => [v, a]))
  return (
    <div className={styles.stages}>
      <h3 className={styles.h3}>Propostas e composição</h3>
      {stages.map((s) => {
        const run = round.variants.find((v) => v.id === s.variantId)
        return (
          <div key={s.id} className={styles.stageCard}>
            <div className={styles.stageHead}>
              <strong>{stageTitle(s)}</strong>
              <span className="muted">{DIM_LABEL[s.dim]}</span>
              {s.keptBase && !s.fellBack && <span className={styles.badge}>KEEP_BASE</span>}
              {s.fellBack && <span className={`${styles.badge} ${styles.stWaiting}`}>herdou o harness atual</span>}
              {s.attempts > 1 && <span className={`${styles.badge} ${styles.stWaiting}`}>{s.attempts} tentativas</span>}
              <span className={styles.spacer} />
              <span className={styles.metric}>{formatCost(s.costUsd)}</span>
              <span className={styles.metric}>{formatDuration(s.durationMs)}</span>
            </div>
            {run && (
              <div className="muted">
                Executado como {run.label}
                {anonOf[run.id] ? ` · candidato ${anonOf[run.id]}` : ' · fora da seleção cega'}
                {run.id === round.selection?.variantId ? ' · vencedor' : ''}
              </div>
            )}
            {s.error && <div className={styles.warnText}>{s.error}</div>}
            {s.notes && <pre className={styles.notes}>{s.notes}</pre>}
            {s.tree && <TreeDiff base={baseTree} tree={s.tree} />}
          </div>
        )
      })}
    </div>
  )
}
