// Repository operations behind the git:* IPC channels.
import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  GitBranch,
  GitChangeCode,
  GitCommit,
  GitDiffRequest,
  GitDiffResult,
  GitFileChange,
  GitPrStatus,
  GitStatus
} from '../../../shared/features/git'
import { git, gitPaths, run } from './exec'

const MAX_FILES_PER_GROUP = 2000
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/** Absolute repository root for `cwd`, or undefined when `cwd` is not inside a work tree. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 10_000 })
    const root = stdout.trim()
    return root ? resolve(root) : undefined
  } catch {
    return undefined
  }
}

async function requireRoot(cwd: string): Promise<string> {
  const root = await repoRoot(cwd)
  if (!root) throw new Error('Esta pasta não é um repositório git.')
  return root
}

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  detached: false,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  truncated: false
}

function code(letter: string): GitChangeCode {
  return ('MADRCTU'.includes(letter) ? letter : 'M') as GitChangeCode
}

export async function status(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd)
  if (!root) return { ...EMPTY_STATUS }
  const { stdout } = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])

  const out: GitStatus = { ...EMPTY_STATUS, isRepo: true, root, staged: [], unstaged: [], untracked: [] }
  const push = (list: GitFileChange[], change: GitFileChange) => {
    if (list.length < MAX_FILES_PER_GROUP) list.push(change)
    else out.truncated = true
  }

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') out.head = value === '(initial)' ? undefined : value.slice(0, 7)
      else if (key === 'branch.head') {
        out.detached = value === '(detached)'
        out.branch = out.detached ? undefined : value
      } else if (key === 'branch.upstream') out.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '?') {
      push(out.untracked, { path: line.slice(2), status: '?' })
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = kind === '1' ? 8 : 9
      const parts = line.split(' ')
      const path = parts.slice(fields).join(' ')
      const origPath = kind === '2' ? tokens[++i] : undefined
      const [x, y] = [parts[1][0], parts[1][1]]
      if (x !== '.') push(out.staged, { path, origPath, status: code(x) })
      if (y !== '.') push(out.unstaged, { path, status: code(y) })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      push(out.unstaged, { path: line.split(' ').slice(10).join(' '), status: 'U' })
    }
  }
  return out
}

export async function diff(cwd: string, req: GitDiffRequest): Promise<GitDiffResult> {
  const root = await requireRoot(cwd)
  let args: string[]
  if (req.untracked) {
    args = ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', req.path]
  } else {
    const paths = req.origPath ? [req.origPath, req.path] : [req.path]
    args = ['diff', '--no-color', '--no-ext-diff', '-M', ...(req.staged ? ['--cached'] : []), '--', ...paths]
  }
  try {
    // --no-index exits 1 when the files differ.
    const { stdout } = await gitPaths(root, args, { okCodes: [0, 1], maxBuffer: MAX_DIFF_BYTES })
    const binary = /^Binary files .* differ$/m.test(stdout) && !/^@@ /m.test(stdout)
    return { text: stdout, binary, truncated: false }
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { text: '', binary: false, truncated: true }
    }
    throw err
  }
}

export async function stage(cwd: string, paths?: string[]): Promise<void> {
  const root = await requireRoot(cwd)
  await gitPaths(root, paths?.length ? ['add', '-A', '--', ...paths] : ['add', '-A'])
}

export async function unstage(cwd: string, paths?: string[]): Promise<void> {
  const root = await requireRoot(cwd)
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] })
  if (hasHead.code === 0) {
    await gitPaths(root, paths?.length ? ['reset', '-q', 'HEAD', '--', ...paths] : ['reset', '-q', 'HEAD'])
  } else {
    // No commits yet: just drop the entries from the index.
    await gitPaths(root, ['rm', '-r', '-q', '--cached', '--', ...(paths?.length ? paths : ['.'])])
  }
}

/** Discards working-tree changes. Untracked paths are deleted from disk. */
export async function discard(cwd: string, paths: string[], untracked = false): Promise<void> {
  const root = await requireRoot(cwd)
  if (!paths.length) return
  if (untracked) {
    for (const p of paths) {
      const abs = resolve(root, p)
      const rel = relative(root, abs)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Caminho fora do repositório: ${p}`)
      await rm(abs, { recursive: true, force: true })
    }
    return
  }
  await gitPaths(root, ['restore', '--worktree', '--', ...paths])
}

export async function commit(cwd: string, message: string): Promise<string> {
  const root = await requireRoot(cwd)
  if (!message.trim()) throw new Error('Escreva uma mensagem de commit.')
  await git(root, ['commit', '-F', '-'], { input: message, timeout: 120_000 })
  const { stdout } = await git(root, ['rev-parse', '--short', 'HEAD'])
  return stdout.trim()
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const root = await requireRoot(cwd)
  const fmt = '%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)'
  const { stdout } = await git(root, [
    'for-each-ref',
    `--format=${fmt}`,
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes'
  ])
  const out: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [ref, head, upstream, date] = line.split('\x1f')
    if (ref.endsWith('/HEAD')) continue
    const remote = ref.startsWith('refs/remotes/')
    out.push({
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      current: head === '*',
      remote,
      upstream: upstream || undefined,
      date: Number(date) || 0
    })
  }
  return out
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  const root = await requireRoot(cwd)
  const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean)
  const remote = remotes.find((r) => branch.startsWith(`${r}/`))
  if (remote) {
    // Remote branch: switch to (or create) the matching local tracking branch.
    const local = branch.slice(remote.length + 1)
    const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], { okCodes: [0, 1] })
    await git(root, exists.code === 0 ? ['switch', local] : ['switch', '--track', '-c', local, branch])
    return
  }
  await git(root, ['switch', branch])
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  const root = await requireRoot(cwd)
  const valid = await git(root, ['check-ref-format', '--branch', name], { okCodes: [0, 1, 128] })
  if (valid.code !== 0) throw new Error(`Nome de branch inválido: ${name}`)
  await git(root, ['switch', '-c', name])
}

export async function push(cwd: string): Promise<string> {
  const root = await requireRoot(cwd)
  const st = await status(root)
  if (!st.branch) throw new Error('HEAD destacado: crie um branch antes de fazer push.')
  const opts = { timeout: 120_000 }
  let res
  if (st.upstream) {
    res = await git(root, ['push'], opts)
  } else {
    const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean)
    if (!remotes.length) throw new Error('Nenhum remote configurado.')
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    res = await git(root, ['push', '-u', remote, st.branch], opts)
  }
  return (res.stderr || res.stdout).trim()
}

export async function log(cwd: string, count = 30): Promise<GitCommit[]> {
  const root = await requireRoot(cwd)
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] })
  if (hasHead.code !== 0) return []
  const n = Math.max(1, Math.min(count, 500))
  const { stdout } = await git(root, ['log', `-n${n}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e'])
  return stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, date, subject] = r.split('\x1f')
      return { hash, short, author, email, date: Number(date), subject }
    })
}

let ghAvailable: Promise<boolean> | undefined

function hasGh(): Promise<boolean> {
  ghAvailable ??= run('gh', process.cwd(), ['--version'], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  return ghAvailable
}

export async function prStatus(cwd: string): Promise<GitPrStatus> {
  if (!(await hasGh())) return { available: false }
  const root = await requireRoot(cwd)
  try {
    const { stdout } = await run('gh', root, ['pr', 'view', '--json', 'number,title,state,url,isDraft'], {
      timeout: 20_000
    })
    const pr = JSON.parse(stdout) as Omit<GitPrStatus, 'available'>
    return { available: true, ...pr }
  } catch {
    // No PR for this branch, no auth or no GitHub remote.
    return { available: true }
  }
}
