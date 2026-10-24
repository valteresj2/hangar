// Main-side API of the git feature, used by other features. Owned by the git agent.
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Worktree } from '../../../shared/contracts'
import { git } from './exec'
import { repoRoot } from './ops'

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function randomSlug(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

async function branchExists(root: string, name: string): Promise<boolean> {
  const res = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { okCodes: [0, 1] })
  return res.code === 0
}

/** Root of the main working tree, even when `cwd` is inside a linked worktree. */
async function mainRoot(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = resolve(stdout.trim())
  return basename(common) === '.git' ? dirname(common) : common
}

/**
 * Creates a linked worktree at `<repo root>/../.hangar-worktrees/<repo>-<slug>` on a new branch
 * started from the current HEAD. Without `branch` the branch is `hangar/<slug>`; a valid `branch`
 * name is used as-is (checked out if it already exists), anything else is slugified under `hangar/`.
 */
export async function createWorktree(cwd: string, branch?: string): Promise<Worktree> {
  if (!(await repoRoot(cwd))) throw new Error('Esta pasta não é um repositório git.')
  const root = await mainRoot(cwd)
  const repoName = slugify(basename(root)) || 'repo'
  const parent = join(dirname(root), '.hangar-worktrees')

  let name: string
  let slug: string
  const wanted = branch?.trim()
  if (wanted) {
    const valid = await git(cwd, ['check-ref-format', '--branch', wanted], { okCodes: [0, 1, 128] })
    if (valid.code === 0) {
      name = wanted
      slug = slugify(wanted.replace(/^hangar\//, '')) || randomSlug()
    } else {
      slug = slugify(wanted) || randomSlug()
      name = `hangar/${slug}`
    }
  } else {
    slug = randomSlug()
    name = `hangar/${slug}`
  }

  // Only the generated names get uniquified; an explicit valid branch is reused if it exists.
  const explicit = !!wanted && name === wanted
  let path = join(parent, `${repoName}-${slug}`)
  for (let n = 2; existsSync(path) || (!explicit && (await branchExists(cwd, name))); n++) {
    path = join(parent, `${repoName}-${slug}-${n}`)
    if (!explicit) name = `hangar/${slug}-${n}`
  }

  await mkdir(parent, { recursive: true })
  const reuse = explicit && (await branchExists(cwd, name))
  await git(cwd, reuse ? ['worktree', 'add', path, name] : ['worktree', 'add', '-b', name, path, 'HEAD'], {
    timeout: 120_000
  })
  return { path, branch: name, baseCwd: cwd }
}

/**
 * Removes the worktree directory and its registration. Branches created by Hangar (`hangar/*`) are
 * deleted only when fully merged, so unmerged work is never lost.
 */
export async function removeWorktree(wt: Worktree): Promise<void> {
  // Resolve the main repository first: baseCwd may itself be a worktree that is already gone.
  const probe = [wt.baseCwd, wt.path].find((p) => existsSync(p))
  const root = probe ? await mainRoot(probe).catch(() => undefined) : undefined
  if (root) {
    try {
      await git(root, ['worktree', 'remove', '--force', wt.path], { timeout: 60_000 })
    } catch {
      // Already unregistered or files locked: fall through to manual cleanup.
    }
  }
  if (existsSync(wt.path)) await rm(wt.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  if (root && existsSync(root)) {
    await git(root, ['worktree', 'prune']).catch(() => undefined)
    if (wt.branch.startsWith('hangar/')) {
      await git(root, ['branch', '-d', wt.branch]).catch(() => undefined)
    }
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!cwd || !existsSync(cwd)) return false
  return (await repoRoot(cwd)) !== undefined
}
