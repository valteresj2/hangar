// File index of a session's working folder, for @mentions in the composer.
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../../core/store'
import { isGitRepo } from '../git/api'

const MAX_WALK = 5000
const MAX_RESULTS = 50
const TTL_MS = 60_000
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out'])

const cache = new Map<string, { files: string[]; at: number; cwd: string }>()

export function invalidateFiles(sessionId: string): void {
  cache.delete(sessionId)
}

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve([...new Set(stdout.split(/\r?\n/).filter(Boolean))]))
    )
  })
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < MAX_WALK) {
    const rel = queue.shift()!
    let items
    try {
      items = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const path = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (!IGNORED_DIRS.has(item.name)) queue.push(path)
      } else if (item.isFile()) {
        out.push(path)
        if (out.length >= MAX_WALK) break
      }
    }
  }
  return out
}

/** Relative paths (forward slashes) of the files in the session folder, cached. */
export async function filesFor(sessionId: string): Promise<string[]> {
  const s = db('sessions').get(sessionId)
  if (!s) return []
  const cwd = s.worktree?.path ?? s.cwd
  const hit = cache.get(sessionId)
  if (hit && hit.cwd === cwd && Date.now() - hit.at < TTL_MS) return hit.files
  let files: string[]
  try {
    files = (await isGitRepo(cwd)) ? await gitFiles(cwd) : await walk(cwd)
  } catch {
    files = await walk(cwd)
  }
  cache.set(sessionId, { files, at: Date.now(), cwd })
  return files
}

/** Subsequence match; consecutive hits, word starts and hits in the file name score higher. */
function score(path: string, query: string): number | undefined {
  const p = path.toLowerCase()
  const base = p.lastIndexOf('/') + 1
  let qi = 0
  let last = -2
  let total = 0
  for (let i = 0; i < p.length && qi < query.length; i++) {
    if (p[i] !== query[qi]) continue
    total += 1
    if (i === last + 1) total += 4
    if (i >= base) total += 2
    if (i === 0 || '/._- '.includes(p[i - 1])) total += 3
    last = i
    qi++
  }
  if (qi < query.length) return undefined
  if (p.slice(base).startsWith(query)) total += 25
  else if (p.slice(base).includes(query)) total += 15
  return total - path.length * 0.02
}

export async function listFiles(sessionId: string, query: string): Promise<string[]> {
  const files = await filesFor(sessionId)
  const q = query.trim().toLowerCase().replace(/\\/g, '/')
  if (!q) {
    const depth = (f: string) => f.split('/').length
    return [...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, MAX_RESULTS)
  }
  const ranked: { path: string; s: number }[] = []
  for (const path of files) {
    const s = score(path, q)
    if (s !== undefined) ranked.push({ path, s })
  }
  return ranked
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_RESULTS)
    .map((r) => r.path)
}
