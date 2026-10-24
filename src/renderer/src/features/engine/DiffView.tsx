import { useMemo } from 'react'
import { diffLines } from 'diff'
import styles from './engine.module.css'

type Line = { type: 'add' | 'del' | 'ctx' | 'gap'; text: string }

const CONTEXT = 3

function buildLines(before: string, after: string): Line[] {
  const raw: Line[] = []
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    const type = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    for (const text of lines) raw.push({ type, text })
  }
  // Collapse long unchanged runs, keeping a few lines of context around each change.
  const out: Line[] = []
  let i = 0
  while (i < raw.length) {
    if (raw[i].type !== 'ctx') {
      out.push(raw[i++])
      continue
    }
    let j = i
    while (j < raw.length && raw[j].type === 'ctx') j++
    const run = raw.slice(i, j)
    const head = i === 0 ? 0 : CONTEXT
    const tail = j === raw.length ? 0 : CONTEXT
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { type: 'gap', text: `… ${run.length - head - tail} linhas sem mudança` }, ...run.slice(run.length - tail))
    } else {
      out.push(...run)
    }
    i = j
  }
  return out
}

export function DiffView({ before, after, maxHeight = 420 }: { before: string; after: string; maxHeight?: number }) {
  const lines = useMemo(() => buildLines(before, after), [before, after])
  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'del').length
  return (
    <div className={styles.diff}>
      <div className={styles.diffStats}>
        <span className={styles.diffAddText}>+{added}</span> <span className={styles.diffDelText}>−{removed}</span>
      </div>
      <div className={styles.diffBody} style={{ maxHeight }}>
        {lines.map((l, i) => (
          <div
            key={i}
            className={l.type === 'add' ? styles.diffAdd : l.type === 'del' ? styles.diffDel : l.type === 'gap' ? styles.diffGap : styles.diffCtx}
          >
            <span className={styles.diffSign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            {l.text || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}
