// Reading and syncing the harness surface of a directory. Only paths accepted by isHarnessPath() are
// ever read, written or deleted; everything else in the directory is invisible to this module.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HarnessTree } from '../../../shared/harness'
import { isHarnessPath } from '../../../shared/harness'
import type { HarnessState } from '../../../shared/features/harness'

export const MAX_FILE_BYTES = 256 * 1024
/** Safety net against pathological trees (e.g. a skill folder with a vendored dependency). */
const MAX_FILES = 2000

/** Normalizes a project-relative path to forward slashes. */
export function relPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function assertHarnessPath(rel: string): string {
  const r = relPath(rel)
  if (!isHarnessPath(r)) throw new Error(`Fora da superfície de harness: ${rel}`)
  return r
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      await walk(root, child, out)
    } else if (e.isFile() && isHarnessPath(child)) {
      out.push(child)
    }
  }
}

/** Harness file paths present in `dir` (text or not). */
async function harnessFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const top of ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json']) {
    if (existsSync(join(dir, top))) out.push(top)
  }
  for (const sub of ['.claude/skills', '.claude/agents', '.claude/commands', '.claude/scripts']) await walk(dir, sub, out)
  return out
}

export async function readHarnessState(dir: string): Promise<HarnessState> {
  const root = resolve(dir)
  const tree: HarnessTree = {}
  const skipped: HarnessState['skipped'] = []
  for (const rel of (await harnessFiles(root)).sort()) {
    const abs = join(root, rel)
    try {
      const st = await stat(abs)
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: 'large' })
        continue
      }
      const buf = await readFile(abs)
      if (isBinary(buf)) {
        skipped.push({ path: rel, reason: 'binary' })
        continue
      }
      tree[rel] = buf.toString('utf8')
    } catch {
      // Vanished between listing and reading: ignore.
    }
  }
  return { dir: root, tree, skipped }
}

export async function readTree(dir: string): Promise<HarnessTree> {
  return (await readHarnessState(dir)).tree
}

/** Removes now-empty folders between `rel`'s parent and the `.claude` root (never `.claude` itself). */
async function pruneEmptyDirs(root: string, rel: string): Promise<void> {
  let d = dirname(rel)
  while (d.startsWith('.claude/') && d !== '.claude') {
    try {
      if ((await readdir(join(root, d))).length > 0) return
      await rmdir(join(root, d))
    } catch {
      return
    }
    d = dirname(d)
  }
}

export async function writeHarnessFile(dir: string, rel: string, content: string): Promise<void> {
  const r = assertHarnessPath(rel)
  const abs = join(resolve(dir), r)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

export async function deleteHarnessFile(dir: string, rel: string): Promise<void> {
  const r = assertHarnessPath(rel)
  const root = resolve(dir)
  await rm(join(root, r), { force: true })
  await pruneEmptyDirs(root, r)
}

/**
 * Makes `dir` hold exactly `tree` on the harness surface: writes changed/new files and deletes text harness
 * files that are not in the tree. Files that readHarness skips (large or binary) are left alone, since a tree
 * can never carry them. Non-harness files are never touched.
 */
export async function syncTree(dir: string, tree: HarnessTree): Promise<void> {
  const root = resolve(dir)
  const wanted = new Map<string, string>()
  for (const [rel, content] of Object.entries(tree)) wanted.set(assertHarnessPath(rel), content)
  const current = await readHarnessState(root)
  for (const rel of Object.keys(current.tree)) {
    if (!wanted.has(rel)) await deleteHarnessFile(root, rel)
  }
  for (const [rel, content] of wanted) {
    if (current.tree[rel] !== content) await writeHarnessFile(root, rel, content)
  }
}
