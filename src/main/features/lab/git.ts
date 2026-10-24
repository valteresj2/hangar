// Small git helpers for the lab: snapshot a working tree as a tree object (through a throwaway
// index, so the worktree's own index is never touched) and diff two such snapshots.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHarnessPath } from '../../../shared/harness'

interface GitOptions {
  env?: Record<string, string>
  okCodes?: number[]
  timeout?: number
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...opts.env }
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        if (!err || (typeof code === 'number' && opts.okCodes?.includes(code))) return resolve(stdout)
        reject(new Error((stderr || stdout || err.message).trim()))
      }
    )
  })
}

export async function hasHead(cwd: string): Promise<boolean> {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] }).then((out) => !!out.trim())
}

/** Uncommitted changes outside the harness surface (worktrees start from HEAD and will not see them). */
export async function hasNonHarnessChanges(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry) continue
    const path = entry.slice(3)
    if (entry[0] === 'R' || entry[0] === 'C') i++ // the next token is the rename source
    if (!isHarnessPath(path)) return true
  }
  return false
}

/** Tree object id of everything in `dir` (tracked + untracked, minus ignored), without touching its index. */
export async function snapshotTree(dir: string): Promise<string> {
  const index = join(tmpdir(), `hangar-lab-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: index }
  try {
    if (await hasHead(dir)) await git(dir, ['read-tree', 'HEAD'], { env })
    await git(dir, ['add', '-A'], { env, timeout: 120_000 })
    return (await git(dir, ['write-tree'], { env })).trim()
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
  }
}

export interface TreeDiff {
  stat: string
  excerpt: string
  truncated: boolean
}

export async function diffTrees(dir: string, from: string, to: string, limit: number): Promise<TreeDiff> {
  const stat = (await git(dir, ['diff', '--stat=120', '--find-renames', from, to])).trim()
  const patch = await git(dir, ['diff', '--no-ext-diff', '--find-renames', from, to])
  const truncated = patch.length > limit
  return { stat, excerpt: truncated ? `${patch.slice(0, limit)}\n… [diff truncated for this comparison]` : patch, truncated }
}
