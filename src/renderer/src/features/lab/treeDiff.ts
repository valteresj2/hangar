// Per-file summary of how a variant's harness differs from the base.
import { diffLines } from 'diff'
import type { HarnessTree } from '@shared/harness'

export interface TreeFileChange {
  path: string
  kind: 'added' | 'removed' | 'changed'
  added: number
  removed: number
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function treeChanges(base: HarnessTree, tree: HarnessTree): TreeFileChange[] {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(tree)])].sort()
  const out: TreeFileChange[] = []
  for (const path of paths) {
    const a = base[path]
    const b = tree[path]
    if (a === b) continue
    if (a === undefined) out.push({ path, kind: 'added', added: lineCount(b), removed: 0 })
    else if (b === undefined) out.push({ path, kind: 'removed', added: 0, removed: lineCount(a) })
    else {
      let added = 0
      let removed = 0
      for (const part of diffLines(a, b)) {
        if (part.added) added += part.count ?? lineCount(part.value)
        else if (part.removed) removed += part.count ?? lineCount(part.value)
      }
      out.push({ path, kind: 'changed', added, removed })
    }
  }
  return out
}
