import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitBranch } from '@shared/features/git'
import { errorMessage, gitApi } from './gitApi'
import styles from './git.module.css'

interface Props {
  cwd: string
  current?: string
  detachedLabel?: string
  disabled?: boolean
  onError(message: string): void
}

/** Branch button with a popover to switch to an existing branch or create a new one. */
export function BranchMenu({ cwd, current, detachedLabel, disabled, onError }: Props) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    gitApi.branches(cwd).then(setBranches, (e) => onError(errorMessage(e)))
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, cwd, onError])

  const q = query.trim()
  const filtered = useMemo(() => {
    const lower = q.toLowerCase()
    return branches.filter((b) => !lower || b.name.toLowerCase().includes(lower))
  }, [branches, q])
  const exact = branches.some((b) => !b.remote && b.name === q)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setOpen(false)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const switchTo = (b: GitBranch) => run(() => gitApi.checkout(cwd, b.name))
  const create = () => run(() => gitApi.createBranch(cwd, q))

  const local = filtered.filter((b) => !b.remote)
  const remote = filtered.filter((b) => b.remote)

  return (
    <div className={styles.branchWrap} ref={root}>
      <button
        className={styles.branchBtn}
        disabled={disabled}
        title="Trocar ou criar branch"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.branchIcon}>⎇</span>
        <span className={styles.branchName}>{current ?? detachedLabel ?? '—'}</span>
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className={styles.popover}>
          <input
            className="input"
            autoFocus
            placeholder="Filtrar ou nome do novo branch…"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter' && q) {
                if (exact) void switchTo(branches.find((b) => !b.remote && b.name === q)!)
                else if (!local.length && !remote.length) void create()
              }
            }}
          />
          <div className={styles.popoverList}>
            {q && !exact && (
              <button className={styles.popoverItem} disabled={busy} onClick={() => void create()}>
                <span className={styles.popoverPlus}>+</span> Criar branch <strong>{q}</strong>
              </button>
            )}
            {local.length > 0 && <div className={styles.popoverLabel}>Locais</div>}
            {local.map((b) => (
              <button
                key={b.name}
                className={`${styles.popoverItem} ${b.current ? styles.popoverCurrent : ''}`}
                disabled={busy || b.current}
                onClick={() => void switchTo(b)}
              >
                <span className={styles.popoverCheck}>{b.current ? '✓' : ''}</span>
                <span className={styles.ellipsis}>{b.name}</span>
              </button>
            ))}
            {remote.length > 0 && <div className={styles.popoverLabel}>Remotos</div>}
            {remote.map((b) => (
              <button key={b.name} className={styles.popoverItem} disabled={busy} onClick={() => void switchTo(b)}>
                <span className={styles.popoverCheck} />
                <span className={styles.ellipsis}>{b.name}</span>
              </button>
            ))}
            {!filtered.length && !q && <div className={styles.popoverEmpty}>Nenhum branch.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
