// Per-file unified diff between two harness trees (computed in main with `diff`).
import { useEffect, useState } from 'react'
import type { HarnessTree } from '@shared/harness'
import type { TreeDiffFile } from '@shared/features/harness'
import { errorText, harnessApi } from './api'
import styles from './harness.module.css'

const STATUS_LABEL: Record<TreeDiffFile['status'], string> = { added: 'novo', removed: 'removido', modified: 'alterado' }

export function DiffView({ from, to, fromLabel, toLabel }: { from: HarnessTree; to: HarnessTree; fromLabel: string; toLabel: string }) {
  const [files, setFiles] = useState<TreeDiffFile[]>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    harnessApi
      .diff(from, to)
      .then((f) => {
        if (!alive) return
        setFiles(f)
        // Small diffs open by default.
        setOpen(Object.fromEntries(f.map((x) => [x.path, f.length <= 3])))
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [from, to])

  if (error) return <div className={styles.error}>{error}</div>
  if (!files) return <div className={styles.empty}>Comparando…</div>

  return (
    <div className={styles.diff}>
      <div className={styles.diffLegend}>
        <span className={styles.delText}>− {fromLabel}</span>
        <span className={styles.addText}>+ {toLabel}</span>
      </div>
      {files.length === 0 && <div className={styles.empty}>Sem diferenças no harness.</div>}
      {files.map((f) => (
        <div key={f.path} className={styles.diffFile}>
          <button className={styles.diffFileHead} onClick={() => setOpen((o) => ({ ...o, [f.path]: !o[f.path] }))}>
            <span className={styles.chev}>{open[f.path] ? '▾' : '▸'}</span>
            <code className={styles.diffPath}>{f.path}</code>
            <span className={`${styles.badge} ${styles[`st_${f.status}`]}`}>{STATUS_LABEL[f.status]}</span>
            <span className={styles.addText}>+{f.additions}</span>
            <span className={styles.delText}>−{f.deletions}</span>
          </button>
          {open[f.path] && (
            <div className={styles.diffBody}>
              {f.hunks.map((h, i) => (
                <div key={i}>
                  <div className={styles.hunkHead}>{h.header}</div>
                  {h.lines.map((l, j) => (
                    <div key={j} className={`${styles.line} ${l.type === 'add' ? styles.lineAdd : l.type === 'del' ? styles.lineDel : ''}`}>
                      <span className={styles.lineNo}>{l.oldNo ?? ''}</span>
                      <span className={styles.lineNo}>{l.newNo ?? ''}</span>
                      <span className={styles.lineSign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                      <span className={styles.lineText}>{l.text || ' '}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
