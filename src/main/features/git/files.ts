// File tree, file reading and "open in editor" for the Files panel.
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { FILE_READ_LIMIT, type FileContent, type FileEntry } from '../../../shared/features/git'
import { git, run } from './exec'
import { repoRoot } from './ops'

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])
const FIND_LIMIT = 500
const WALK_LIMIT = 20_000

async function ignoredSet(dir: string, names: string[]): Promise<Set<string>> {
  if (!names.length || !(await repoRoot(dir))) return new Set()
  try {
    // Exit code 1 means "nothing ignored".
    const { stdout } = await git(dir, ['check-ignore', '--stdin', '-z'], {
      input: names.join('\0') + '\0',
      okCodes: [0, 1]
    })
    return new Set(stdout.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Direct children of `dir`, directories first. `.git` and `node_modules` are always skipped. */
export async function listDir(dir: string): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const kept = dirents.filter((d) => !ALWAYS_HIDDEN.has(d.name))
  const ignored = await ignoredSet(
    dir,
    kept.map((d) => d.name)
  )
  const entries = await Promise.all(
    kept.map(async (d): Promise<FileEntry> => {
      const path = join(dir, d.name)
      let isDir = d.isDirectory()
      let size: number | undefined
      if (d.isSymbolicLink() || d.isFile()) {
        const st = await stat(path).catch(() => undefined)
        if (st) {
          isDir = st.isDirectory()
          size = st.isFile() ? st.size : undefined
        }
      }
      return { name: d.name, path, isDir, size, ignored: ignored.has(d.name) || undefined }
    })
  )
  return entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

async function walk(root: string, visit: (rel: string) => boolean): Promise<void> {
  const queue = [root]
  let seen = 0
  while (queue.length) {
    const dir = queue.shift()!
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const d of dirents) {
      if (ALWAYS_HIDDEN.has(d.name)) continue
      const abs = join(dir, d.name)
      if (d.isDirectory()) queue.push(abs)
      else if (!visit(relative(root, abs)) || ++seen > WALK_LIMIT) return
    }
  }
}

/** Files under `root` whose relative path contains `query` (case-insensitive). Respects .gitignore in repos. */
export async function findFiles(root: string, query: string): Promise<FileEntry[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: string[] = []
  const accept = (rel: string) => {
    if (rel.toLowerCase().includes(q)) hits.push(rel)
    return hits.length < FIND_LIMIT
  }
  if (await repoRoot(root)) {
    const { stdout } = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    for (const rel of new Set(stdout.split('\0'))) {
      if (rel && !accept(rel)) break
    }
  } else {
    await walk(root, accept)
  }
  return hits.map((rel) => {
    const path = resolve(root, rel)
    return { name: rel.replace(/\\/g, '/'), path, isDir: false }
  })
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function readFileContent(path: string): Promise<FileContent> {
  const st = await stat(path)
  if (st.isDirectory()) throw new Error('É uma pasta.')
  const fh = await open(path, 'r')
  try {
    const len = Math.min(st.size, FILE_READ_LIMIT)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    const binary = looksBinary(buf)
    return {
      path,
      size: st.size,
      binary,
      truncated: st.size > FILE_READ_LIMIT,
      text: binary ? undefined : buf.toString('utf8')
    }
  } finally {
    await fh.close()
  }
}

let editorExe: Promise<string | undefined> | undefined

/** Locates the VS Code (or Cursor) GUI executable next to its CLI shim on PATH. */
function findEditor(): Promise<string | undefined> {
  editorExe ??= (async () => {
    if (process.platform !== 'win32') {
      for (const cli of ['code', 'cursor']) {
        const ok = await run('which', process.cwd(), [cli]).catch(() => undefined)
        if (ok?.stdout.trim()) return ok.stdout.trim().split('\n')[0]
      }
      return undefined
    }
    for (const [cli, exe] of [
      ['code', 'Code.exe'],
      ['cursor', 'Cursor.exe']
    ]) {
      const res = await run('where.exe', process.cwd(), [cli]).catch(() => undefined)
      for (const shim of res?.stdout.split(/\r?\n/).filter(Boolean) ?? []) {
        // <install>\bin\code.cmd -> <install>\Code.exe
        const candidate = join(dirname(dirname(shim)), exe)
        if (existsSync(candidate)) return candidate
      }
    }
    return undefined
  })()
  return editorExe
}

export async function openInEditor(path: string, line?: number): Promise<void> {
  const editor = await findEditor()
  if (editor) {
    const target = line ? `${path}:${line}` : path
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Detached: when no editor instance is running, this process becomes the editor itself.
    const child = spawn(editor, line ? ['--goto', target] : [target], {
      cwd: dirname(path),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.on('error', () => undefined)
    child.unref()
    return
  }
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
}
