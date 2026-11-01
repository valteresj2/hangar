// Discovery and import of the ChatGPT desktop app's projects and conversations (Work/Codex), read from its local
// data folder (~/.codex, or CODEX_HOME). Those files belong to the ChatGPT app and are not documented, so every
// read is defensive: what we do not recognize is skipped, never written to, and never fails the whole list.
//
//   state_<n>.sqlite          projects (name), project_roots (folder) and threads (title, folder, rollout file)
//   thread_history_<n>.sqlite thread_items: the clean userMessage / agentMessage items of each thread
//   sessions/**/rollout-*.jsonl[.zst]  the raw thread log, used when the history index is missing

import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { nanoid } from 'nanoid'
import type { Project, Session } from '../../../shared/contracts'
import type {
  ChatgptImportInput,
  ChatgptImportResult,
  ChatgptProjectInfo,
  ChatgptScan,
  ChatgptThreadInfo
} from '../../../shared/features/sessions'
import { db } from '../../core/store'
import { seedTranscript, type SeedEntry } from '../engine/api'
import { assertCanCreateSessions } from '../platform/api'

const TITLE_MAX = 80
/** How much of a conversation goes along as context (the latest part when longer). */
const CONTEXT_MAX = 12_000

/** Hangar project instructions for a ChatGPT project that has an AGENTS.md (Claude Code only reads CLAUDE.md). */
export const AGENTS_MD_INSTRUCTIONS =
  'Este projeto veio do ChatGPT e as instruções dele estão no arquivo AGENTS.md, na raiz da pasta. Leia esse ' +
  'arquivo no início de cada tarefa e siga o que ele diz, a menos que a pessoa peça outra coisa.'

type Row = Record<string, unknown>

interface Message {
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** ChatGPT's progress notes between tool calls ("commentary"); shown, but left out of the context. */
  commentary?: boolean
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(app.getPath('home'), '.codex')
}

/** The newest `<prefix>_<n>.sqlite` in the folder (the ChatGPT app bumps n on schema changes). */
function latestDb(dir: string, prefix: string): string | undefined {
  let best: { n: number; name: string } | undefined
  try {
    for (const name of readdirSync(dir)) {
      const m = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(name)
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), name }
    }
  } catch {
    return undefined
  }
  return best && join(dir, best.name)
}

function query(file: string | undefined, sql: string, ...params: (string | number)[]): Row[] {
  if (!file) return []
  let conn: DatabaseSync | undefined
  try {
    conn = new DatabaseSync(file, { readOnly: true })
    return conn.prepare(sql).all(...params)
  } catch (err) {
    console.warn('[sessions] could not read ChatGPT data', basename(file), (err as Error).message)
    return []
  } finally {
    conn?.close()
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined

/** Drops the Windows extended-length prefix (`\\?\C:\…`) the ChatGPT app stores on some paths. */
function cleanPath(p: string): string {
  return p.replace(/^\\\\\?\\/, '')
}

function normPath(p: string): string {
  return cleanPath(p)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

function inside(child: string, root: string): boolean {
  const c = normPath(child)
  const r = normPath(root)
  return c === r || c.startsWith(`${r}/`)
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/** Epoch ms from a `<col>_ms` column, or from the seconds one. */
function timeOf(row: Row, col: string): number {
  const ms = num(row[`${col}_ms`])
  if (ms) return ms
  const s = num(row[col])
  return s ? (s < 1e12 ? s * 1000 : s) : 0
}

interface ScannedThread extends Omit<ChatgptThreadInfo, 'imported'> {
  cwd: string
  projectId?: string
  rolloutPath?: string
}

function scanThreads(state: string | undefined, historyDb: string | undefined): ScannedThread[] {
  const counts = new Map<string, number>()
  for (const r of query(
    historyDb,
    "SELECT thread_id, COUNT(*) AS n FROM thread_items WHERE item_type IN ('userMessage', 'agentMessage') GROUP BY thread_id"
  )) {
    const id = str(r.thread_id)
    if (id) counts.set(id, num(r.n) ?? 0)
  }
  const out: ScannedThread[] = []
  for (const r of query(state, 'SELECT * FROM threads')) {
    const id = str(r.id)
    const cwd = str(r.cwd)
    if (!id || !cwd) continue
    // Subagent threads (e.g. the "guardian" reviews) and archived ones stay out. (`has_user_event` is 0 even on the
    // person's own conversations, so it says nothing here.)
    if (str(r.source)?.includes('subagent') || str(r.attached_thread_parent_id)) continue
    if (num(r.archived)) continue
    const title = str(r.name) ?? str(r.title) ?? str(r.first_user_message) ?? 'Conversa do ChatGPT'
    out.push({
      id,
      title: oneLine(title),
      cwd: cleanPath(cwd),
      createdAt: timeOf(r, 'created_at'),
      updatedAt: timeOf(r, 'updated_at'),
      messages: counts.get(id) ?? 0,
      projectId: str(r.project_id),
      rolloutPath: str(r.rollout_path) && cleanPath(str(r.rollout_path)!)
    })
  }
  return out
}

function scanProjects(state: string | undefined): { id: string; name: string; cwd: string }[] {
  const roots = new Map<string, string>()
  for (const r of query(state, 'SELECT project_id, path FROM project_roots ORDER BY position')) {
    const id = str(r.project_id)
    const path = str(r.path)
    if (id && path && !roots.has(id)) roots.set(id, cleanPath(path))
  }
  const out: { id: string; name: string; cwd: string }[] = []
  for (const r of query(state, 'SELECT id, name FROM projects ORDER BY position')) {
    const id = str(r.id)
    const cwd = id && roots.get(id)
    if (id && cwd) out.push({ id, name: str(r.name) ?? basename(cwd), cwd })
  }
  return out
}

function importedThreads(): Set<string> {
  return new Set(
    db('sessions')
      .list()
      .flatMap((s) => (s.imported?.from === 'chatgpt' ? [s.imported.threadId] : []))
  )
}

function hangarProjectFor(cwd: string): Project | undefined {
  return db('projects')
    .list()
    .find((p) => normPath(p.cwd) === normPath(cwd))
}

interface Scanned {
  scan: ChatgptScan
  threads: Map<string, ScannedThread>
}

function scanAll(): Scanned {
  const dir = codexHome()
  const state = latestDb(dir, 'state')
  const threads = new Map<string, ScannedThread>()
  if (!state) return { scan: { found: false, dir, projects: [] }, threads }

  const projects = new Map<string, ChatgptProjectInfo>()
  const done = importedThreads()
  const add = (key: string, name: string, cwd: string): ChatgptProjectInfo => {
    let p = projects.get(key)
    if (!p) {
      p = {
        key,
        name,
        cwd,
        exists: existsSync(cwd),
        agentsMd: existsSync(join(cwd, 'AGENTS.md')),
        imported: !!hangarProjectFor(cwd),
        threads: []
      }
      projects.set(key, p)
    }
    return p
  }
  const named = scanProjects(state)
  for (const p of named) add(p.id, p.name, p.cwd)

  for (const t of scanThreads(state, latestDb(dir, 'thread_history'))) {
    threads.set(t.id, t)
    // Its project: the one it was started in, else the project whose folder holds it, else its own folder.
    const owner =
      named.find((p) => p.id === t.projectId) ??
      named.filter((p) => inside(t.cwd, p.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0]
    const project = owner ? projects.get(owner.id)! : add(`cwd:${normPath(t.cwd)}`, basename(t.cwd), t.cwd)
    const { cwd: _cwd, projectId: _p, rolloutPath: _r, ...info } = t
    project.threads.push({ ...info, imported: done.has(t.id) })
  }

  const latest = (p: ChatgptProjectInfo) => Math.max(0, ...p.threads.map((t) => t.updatedAt))
  for (const p of projects.values()) p.threads.sort((a, b) => b.updatedAt - a.updatedAt)
  const list = [...projects.values()].sort((a, b) => latest(b) - latest(a) || a.name.localeCompare(b.name))
  return { scan: { found: true, dir, projects: list }, threads }
}

export function listChatgpt(): ChatgptScan {
  return scanAll().scan
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((b) => {
      const block = b as { type?: string; text?: unknown }
      return typeof block?.text === 'string' && block.type !== 'image' ? [block.text] : []
    })
    .join('\n')
}

/** The thread's messages from ChatGPT's history index (clean user and assistant items, in order). */
function messagesFromHistory(threadId: string): Message[] {
  const historyDb = latestDb(codexHome(), 'thread_history')
  const out: Message[] = []
  for (const r of query(
    historyDb,
    "SELECT item_json, item_type, created_at_ms FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal",
    threadId
  )) {
    let item: { content?: unknown; text?: unknown; phase?: unknown }
    try {
      item = JSON.parse(String(r.item_json)) as typeof item
    } catch {
      continue
    }
    const ts = num(r.created_at_ms) ?? 0
    if (r.item_type === 'userMessage') {
      const text = textOf(item.content).trim()
      if (text) out.push({ role: 'user', text, ts })
    } else {
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (text) out.push({ role: 'assistant', text, ts, commentary: item.phase === 'commentary' })
    }
  }
  return out
}

/** Fallback: the raw thread log (JSONL, compressed with zstd by newer ChatGPT versions). */
function messagesFromRollout(file: string | undefined): Message[] {
  if (!file || !existsSync(file)) return []
  let raw: string
  try {
    const buf = readFileSync(file)
    raw = (file.endsWith('.zst') ? zstdDecompressSync(buf) : buf).toString('utf8')
  } catch {
    return []
  }
  const users: Message[] = []
  const legacyUsers: Message[] = []
  const assistants: Message[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: { timestamp?: string; type?: string; payload?: Row }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    const p = row.payload ?? {}
    const ts = Date.parse(row.timestamp ?? '') || 0
    const item = p.item as { type?: string; content?: unknown } | undefined
    if (row.type === 'event_msg' && p.type === 'item_completed' && item?.type === 'UserMessage') {
      const text = textOf(item.content).trim()
      if (text) users.push({ role: 'user', text, ts })
    } else if (row.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      if (p.message.trim()) legacyUsers.push({ role: 'user', text: p.message.trim(), ts })
    } else if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content).trim()
      if (text) assistants.push({ role: 'assistant', text, ts })
    }
  }
  // Older logs only have the `user_message` events; newer ones have both, so one of them is enough.
  return [...(users.length ? users : legacyUsers), ...assistants].sort((a, b) => a.ts - b.ts)
}

/** The conversation as plain text for the model, keeping the latest part when it is long. */
export function contextOf(messages: Message[]): string {
  const blocks = messages
    .filter((m) => !m.commentary)
    .map((m) => `${m.role === 'user' ? 'Pessoa' : 'ChatGPT'}: ${m.text}`)
  const kept: string[] = []
  let size = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (size + blocks[i].length > CONTEXT_MAX && kept.length) break
    kept.unshift(blocks[i].slice(-CONTEXT_MAX))
    size += blocks[i].length
  }
  const cut = kept.length < blocks.length ? '[início da conversa omitido]\n\n' : ''
  return cut + kept.join('\n\n')
}

/** System-prompt appendix for an imported session (registered by the sessions feature). */
export function importedContextAppend(session: Session): string | undefined {
  if (session.imported?.from !== 'chatgpt' || !session.imported.context.trim()) return undefined
  return [
    'Esta sessão continua uma conversa que a pessoa teve no ChatGPT, nesta mesma pasta. Essa conversa não está no',
    'seu histórico: use o texto abaixo como contexto do que já foi pedido e feito.',
    '',
    '<conversa-chatgpt>',
    session.imported.context,
    '</conversa-chatgpt>'
  ].join('\n')
}

export function importChatgpt(input: ChatgptImportInput): ChatgptImportResult {
  // Mode "required" without a platform connection: no new sessions from here either.
  assertCanCreateSessions()
  const { scan, threads } = scanAll()
  const wantedThreads = new Set(input.threads)
  const wantedProjects = new Set(input.projects)
  for (const p of scan.projects) if (p.threads.some((t) => wantedThreads.has(t.id))) wantedProjects.add(p.key)

  let projects = 0
  let sessions = 0
  let skipped = 0
  for (const p of scan.projects) {
    if (!wantedProjects.has(p.key)) continue
    if (!p.exists) {
      skipped += 1 + p.threads.filter((t) => wantedThreads.has(t.id)).length
      continue
    }
    let project = hangarProjectFor(p.cwd)
    if (!project) {
      project = {
        id: nanoid(),
        name: p.name,
        cwd: p.cwd,
        ...(p.agentsMd ? { instructions: AGENTS_MD_INSTRUCTIONS } : {}),
        createdAt: Date.now()
      }
      db('projects').put(project)
      projects++
    }
    for (const info of p.threads) {
      if (!wantedThreads.has(info.id)) continue
      if (info.imported) {
        skipped++
        continue
      }
      const t = threads.get(info.id)!
      let messages = messagesFromHistory(t.id)
      if (!messages.length) messages = messagesFromRollout(t.rolloutPath)
      const session: Session = {
        id: nanoid(),
        title: t.title,
        cwd: t.cwd,
        projectId: project.id,
        pinned: false,
        archived: false,
        unread: false,
        status: 'idle',
        createdAt: t.createdAt || Date.now(),
        updatedAt: t.updatedAt || Date.now(),
        imported: { from: 'chatgpt', threadId: t.id, context: contextOf(messages) }
      }
      const note: SeedEntry = {
        kind: 'system',
        text: messages.length
          ? 'Conversa importada do ChatGPT. Ao continuar aqui, o modelo recebe esta conversa como contexto.'
          : 'Conversa importada do ChatGPT, mas o conteúdo dela não pôde ser lido.',
        ts: messages[0]?.ts || session.createdAt
      }
      const entries = messages.map((m): SeedEntry => ({ kind: m.role, text: m.text, ts: m.ts || session.createdAt }))
      db('sessions').put(session)
      seedTranscript(session.id, [note, ...entries])
      sessions++
    }
  }
  skipped += [...wantedThreads].filter((id) => !threads.has(id)).length
  return { projects, sessions, skipped }
}
