// Minimal unified-diff parser producing display rows for the unified and split views.

export type RowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'note'

export interface DiffRow {
  kind: RowKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface SplitRow {
  kind: 'hunk' | 'meta' | 'note' | 'pair'
  text?: string
  left?: DiffRow
  right?: DiffRow
}

const MAX_ROWS = 20_000

// File headers already shown elsewhere; mode/rename/binary lines are kept as meta rows.
const SKIPPED_HEADER = /^(diff --git |index |--- |\+\+\+ )/
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseUnifiedDiff(text: string): { rows: DiffRow[]; truncated: boolean } {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    if (rows.length >= MAX_ROWS) return { rows, truncated: true }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const hunk = HUNK.exec(line)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    const sign = inHunk ? line[0] : undefined
    if (sign === '+') rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    else if (sign === '-') rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (sign === '\\') rows.push({ kind: 'note', text: line })
    else if (inHunk && (sign === ' ' || line === ''))
      rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    else {
      // Outside a hunk: file headers of the (next) file.
      inHunk = false
      if (!SKIPPED_HEADER.test(line)) rows.push({ kind: 'meta', text: line })
    }
  }
  return { rows, truncated: false }
}

/** Pairs deletions with the additions that follow them, GitHub-style. */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let dels: DiffRow[] = []
  let adds: DiffRow[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++)
      out.push({ kind: 'pair', left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const row of rows) {
    if (row.kind === 'del') {
      if (adds.length) flush()
      dels.push(row)
    } else if (row.kind === 'add') {
      adds.push(row)
    } else {
      flush()
      if (row.kind === 'ctx') out.push({ kind: 'pair', left: row, right: row })
      else out.push({ kind: row.kind, text: row.text })
    }
  }
  flush()
  return out
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}
