import { useMemo } from 'react'
import { parseUnifiedDiff, toSplitRows, type DiffRow } from './diff'
import styles from './git.module.css'

export type DiffMode = 'unified' | 'split'

const ROW_CLASS: Record<string, string | undefined> = {
  add: styles.rowAdd,
  del: styles.rowDel,
  hunk: styles.rowHunk,
  meta: styles.rowMeta,
  note: styles.rowMeta
}

function Half({ row, side }: { row?: DiffRow; side: 'old' | 'new' }) {
  const cls = row && row.kind !== 'ctx' ? ROW_CLASS[row.kind] : row ? undefined : styles.cellEmpty
  return (
    <>
      <td className={`${styles.lineNo} ${cls ?? ''}`}>{side === 'old' ? row?.oldNo : row?.newNo}</td>
      <td className={`${styles.code} ${styles.codeWrap} ${cls ?? ''}`}>{row?.text}</td>
    </>
  )
}

export function DiffView({ text, mode }: { text: string; mode: DiffMode }) {
  const parsed = useMemo(() => parseUnifiedDiff(text), [text])
  const split = useMemo(() => (mode === 'split' ? toSplitRows(parsed.rows) : []), [parsed, mode])

  if (!parsed.rows.length) return <div className={styles.empty}>Sem diferenças para mostrar.</div>

  return (
    <div className={styles.diffScroll}>
      {mode === 'unified' ? (
        <table className={styles.diffTable}>
          <tbody>
            {parsed.rows.map((r, i) =>
              r.kind === 'hunk' || r.kind === 'meta' || r.kind === 'note' ? (
                <tr key={i} className={ROW_CLASS[r.kind]}>
                  <td colSpan={4} className={styles.code}>
                    {r.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={ROW_CLASS[r.kind]}>
                  <td className={styles.lineNo}>{r.oldNo}</td>
                  <td className={styles.lineNo}>{r.newNo}</td>
                  <td className={styles.sign}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                  <td className={styles.code}>{r.text}</td>
                </tr>
              )
            )}
          </tbody>
        </table>
      ) : (
        <table className={`${styles.diffTable} ${styles.splitTable}`}>
          <colgroup>
            <col className={styles.colNo} />
            <col />
            <col className={styles.colNo} />
            <col />
          </colgroup>
          <tbody>
            {split.map((r, i) =>
              r.kind === 'pair' ? (
                <tr key={i}>
                  <Half row={r.left} side="old" />
                  <Half row={r.right} side="new" />
                </tr>
              ) : (
                <tr key={i} className={ROW_CLASS[r.kind]}>
                  <td colSpan={4} className={`${styles.code} ${styles.codeWrap}`}>
                    {r.text}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      )}
      {parsed.truncated && <div className={styles.notice}>Diff muito longo: exibindo só o começo.</div>}
    </div>
  )
}
