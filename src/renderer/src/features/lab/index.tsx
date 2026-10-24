// Feature "lab" — renderer side. Owned by the lab agent.
import { useEffect, useState } from 'react'
import { isBaseVariant, type LabRoundView } from '@shared/features/lab'
import { useUi } from '../../core/ui'
import { formatDate, useLabRounds } from './labApi'
import { NewRound } from './NewRound'
import { ROUND_STATUS, RoundDetail } from './RoundDetail'
import styles from './lab.module.css'

function winnerLabel(r: LabRoundView): string | undefined {
  if (r.status !== 'decided') return undefined
  const v = r.variants.find((x) => x.id === r.selection?.variantId)
  return v ? (isBaseVariant(v) ? 'Base mantida' : (v.roleLabel ?? v.label)) : undefined
}

function modeLabel(r: LabRoundView): string {
  if (r.mode === 'parallel') return `automático paralelo · k=${r.depth ?? 1}`
  if (r.mode === 'sequential') return `automático sequencial · K=${r.depth ?? 1}`
  return `base + ${r.variants.length - 1} variante${r.variants.length === 2 ? '' : 's'}`
}

function isEditable(el: Element | null): boolean {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)
}

/** Full-screen Harness Lab for one project directory: rounds, variants, blind selection. */
export function LabView({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const rounds = useLabRounds(cwd)
  const selectSession = useUi((s) => s.selectSession)
  const [selected, setSelected] = useState<string | 'new'>()

  // Default selection: the newest round, or the form when there is none.
  useEffect(() => {
    if (!rounds || selected) return
    setSelected(rounds[0]?.id ?? 'new')
  }, [rounds, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Esc inside a field only leaves the field; a second Esc closes the Lab.
      if (isEditable(document.activeElement)) return (document.activeElement as HTMLElement).blur()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openSession = (id: string) => {
    selectSession(id)
    onClose()
  }

  const round = rounds?.find((r) => r.id === selected)

  return (
    <div className={styles.lab}>
      <header className={styles.topbar}>
        <button className="btn" onClick={onClose} title="Voltar (Esc)">
          ← Voltar
        </button>
        <div className={styles.title}>Harness Lab</div>
        <div className={styles.project} title={cwd}>
          {cwd}
        </div>
        <div className={styles.spacer} />
        <button className="btn btn-primary" onClick={() => setSelected('new')}>
          Nova rodada
        </button>
      </header>
      <div className={styles.body}>
        <aside className={styles.list}>
          <p className={styles.intro}>
            A mesma tarefa roda com o harness atual (base) e com variantes, cada uma num worktree. Os entregáveis são
            comparados às cegas — manter a base é um resultado válido.
          </p>
          {!rounds && <div className="muted">Carregando…</div>}
          {rounds?.length === 0 && <div className="muted">Nenhuma rodada ainda.</div>}
          {rounds?.map((r) => (
            <button
              key={r.id}
              className={`${styles.listItem} ${r.id === selected ? styles.listItemActive : ''}`}
              onClick={() => setSelected(r.id)}
            >
              <div className={styles.listTop}>
                <span className={`${styles.badge} ${styles[`round_${r.status}`] ?? ''}`}>{ROUND_STATUS[r.status]}</span>
                <span className={styles.listDate}>{formatDate(r.createdAt)}</span>
              </div>
              <div className={styles.listTask}>{r.task}</div>
              <div className={styles.listMeta}>
                {modeLabel(r)}
                {winnerLabel(r) && <> · vencedor: {winnerLabel(r)}</>}
              </div>
            </button>
          ))}
        </aside>
        <main className={styles.main}>
          {selected === 'new' ? (
            <NewRound
              cwd={cwd}
              history={rounds ?? []}
              onCreated={(id) => setSelected(id)}
              onCancel={() => setSelected(rounds?.[0]?.id ?? 'new')}
            />
          ) : round ? (
            <RoundDetail key={round.id} round={round} onOpenSession={openSession} />
          ) : (
            <div className={styles.detail}>
              <div className="muted">Selecione uma rodada.</div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
