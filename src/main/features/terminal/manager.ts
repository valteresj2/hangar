// PTY lifecycle: spawn, batched output, scrollback for renderer reloads, kill.
// node-pty is loaded lazily so a broken native module only disables terminals, not the app.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { nanoid } from 'nanoid'
import type { IPty } from 'node-pty'
import type {
  CreateTerminalOptions,
  ShellInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSnapshot
} from '../../../shared/features/terminal'
import { TERMINAL } from '../../../shared/features/terminal'
import { broadcast } from '../../core/broadcast'
import { detectShells } from './shells'

type NodePty = typeof import('node-pty')

const FLUSH_MS = 8
/** Characters of recent output kept per terminal to rebuild the screen after a renderer reload. */
const SCROLLBACK_CHARS = 256 * 1024

interface Term {
  info: TerminalInfo
  proc: IPty
  pending: string
  seq: number
  chunks: string[]
  size: number
  killed: boolean
}

const terms = new Map<string, Term>()
let flushTimer: NodeJS.Timeout | undefined
let ptyModule: Promise<NodePty> | undefined

function loadPty(): Promise<NodePty> {
  if (!ptyModule) {
    ptyModule = import('node-pty').then((m) => ((m as { default?: NodePty }).default ?? m) as NodePty)
    // Allow a retry on the next create instead of caching the failure.
    ptyModule.catch(() => (ptyModule = undefined))
  }
  return ptyModule
}

function shellEnv(shell: ShellInfo): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // ELECTRON_RUN_AS_NODE & co. would leak into tools started from the shell.
    if (value !== undefined && !key.startsWith('ELECTRON_')) env[key] = value
  }
  env.TERM_PROGRAM = 'Hangar'
  env.COLORTERM = 'truecolor'
  // Keeps `bash --login` in the requested cwd instead of jumping to $HOME.
  if (shell.id === 'gitbash') env.CHERE_INVOKING = '1'
  return env
}

function remember(t: Term, data: string): void {
  t.chunks.push(data)
  t.size += data.length
  while (t.size > SCROLLBACK_CHARS && t.chunks.length > 1) t.size -= t.chunks.shift()!.length
  if (t.size > SCROLLBACK_CHARS) {
    t.chunks[0] = t.chunks[0].slice(-SCROLLBACK_CHARS)
    t.size = t.chunks[0].length
  }
}

function flushOne(t: Term): void {
  if (!t.pending) return
  const data = t.pending
  t.pending = ''
  t.seq++
  remember(t, data)
  broadcast(TERMINAL.data, { id: t.info.id, data, seq: t.seq } satisfies TerminalDataEvent)
}

function flushAll(): void {
  flushTimer = undefined
  for (const t of terms.values()) flushOne(t)
}

function nextTitle(sessionId: string, shell: ShellInfo): string {
  let n = 1
  for (const t of terms.values()) if (t.info.sessionId === sessionId && t.info.shellId === shell.id) n++
  return n > 1 ? `${shell.name} ${n}` : shell.name
}

export function shells(): ShellInfo[] {
  return detectShells()
}

export async function createTerminal(opts: CreateTerminalOptions): Promise<TerminalInfo> {
  const pty = await loadPty()
  const available = detectShells()
  const shell = available.find((s) => s.id === opts.shell) ?? available[0]
  if (!shell) throw new Error('Nenhum shell encontrado nesta máquina.')
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()

  const proc = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color',
    cols: Math.max(2, Math.floor(opts.cols) || 80),
    rows: Math.max(2, Math.floor(opts.rows) || 24),
    cwd,
    env: shellEnv(shell)
  })

  const info: TerminalInfo = {
    id: nanoid(10),
    sessionId: opts.sessionId,
    shellId: shell.id,
    title: opts.title?.trim() || nextTitle(opts.sessionId, shell),
    cwd,
    pid: proc.pid,
    createdAt: Date.now()
  }
  const t: Term = { info, proc, pending: '', seq: 0, chunks: [], size: 0, killed: false }
  terms.set(info.id, t)

  proc.onData((data) => {
    t.pending += data
    flushTimer ??= setTimeout(flushAll, FLUSH_MS)
  })
  proc.onExit(({ exitCode }) => {
    flushOne(t)
    terms.delete(info.id)
    broadcast(TERMINAL.exit, { id: info.id, code: exitCode, killed: t.killed } satisfies TerminalExitEvent)
  })

  // Sent before the invoke reply and before any output, so renderers always know the id first.
  broadcast(TERMINAL.created, info)
  return info
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = terms.get(id)
  if (!t || !(cols > 0) || !(rows > 0)) return
  try {
    t.proc.resize(Math.floor(cols), Math.floor(rows))
  } catch {
    // The process may have exited between the renderer's resize and this call.
  }
}

export function renameTerminal(id: string, title: string): void {
  const t = terms.get(id)
  if (t && title.trim()) t.info.title = title.trim()
}

export function killTerminal(id: string): void {
  const t = terms.get(id)
  if (!t) return
  t.killed = true
  try {
    t.proc.kill()
  } catch {
    // Already gone.
  }
}

export function killWhere(predicate: (info: TerminalInfo) => boolean): void {
  for (const t of [...terms.values()]) if (predicate(t.info)) killTerminal(t.info.id)
}

export function listTerminals(sessionId?: string): TerminalSnapshot[] {
  const out: TerminalSnapshot[] = []
  for (const t of terms.values()) {
    if (sessionId && t.info.sessionId !== sessionId) continue
    // Only flushed output is included; pending output arrives later as a data event with a higher seq.
    out.push({ ...t.info, buffer: t.chunks.join(''), seq: t.seq })
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export function disposeAll(): void {
  clearTimeout(flushTimer)
  flushTimer = undefined
  killWhere(() => true)
  terms.clear()
}
