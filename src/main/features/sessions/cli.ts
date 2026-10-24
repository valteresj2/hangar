// Discovery and import of Claude Code CLI sessions (~/.claude/projects/<project>/<session>.jsonl).
// Files can be tens of MB, so they are streamed line by line and only the few lines we need are parsed.
// Results are cached per file (mtime + size).

import { app } from 'electron'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { nanoid } from 'nanoid'
import type { Session } from '../../../shared/contracts'
import type { CliSessionInfo, ImportCliResult } from '../../../shared/features/sessions'
import { db } from '../../core/store'

type ScannedSession = Omit<CliSessionInfo, 'imported'>

const cache = new Map<string, { mtimeMs: number; size: number; info: ScannedSession | undefined }>()

const TITLE_MAX = 80

function projectsDir(): string {
  return join(app.getPath('home'), '.claude', 'projects')
}

/** Text of a user message, or undefined for tool results / command wrappers / injected context. */
function promptText(content: unknown): string | undefined {
  let text: string | undefined
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown }
      if (b.type === 'tool_result') return undefined
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    text = parts.join('\n')
  }
  text = text?.trim()
  // Slash-command wrappers, local command output, system reminders, etc.
  if (!text || text.startsWith('<')) return undefined
  return text
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

async function scanFile(file: string, mtimeMs: number): Promise<ScannedSession | undefined> {
  let sessionId: string | undefined
  let cwd: string | undefined
  let firstPrompt: string | undefined
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let createdAt: number | undefined
  let messages = 0

  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    const isUser = line.includes('"type":"user"')
    const isAssistant = !isUser && line.includes('"type":"assistant"')
    const isTitle = line.includes('"type":"custom-title"') || line.includes('"type":"ai-title"')
    if (isUser || isAssistant) messages++
    // Only parse what we still need: the first prompt line(s) and title records.
    if (!isTitle && !(isUser && !firstPrompt)) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') customTitle = row.customTitle
    else if (row.type === 'ai-title' && typeof row.aiTitle === 'string') aiTitle = row.aiTitle
    else if (row.type === 'user' && !row.isSidechain) {
      if (typeof row.sessionId === 'string') sessionId ??= row.sessionId
      if (typeof row.cwd === 'string') cwd ??= row.cwd
      if (typeof row.timestamp === 'string') createdAt ??= Date.parse(row.timestamp)
      if (!row.isMeta) firstPrompt = promptText((row.message as { content?: unknown } | undefined)?.content)
    }
  }

  if (!cwd || !firstPrompt) return undefined
  return {
    sdkSessionId: sessionId ?? basename(file, '.jsonl'),
    cwd,
    title: oneLine(customTitle || aiTitle || firstPrompt),
    createdAt: createdAt && !Number.isNaN(createdAt) ? createdAt : mtimeMs,
    updatedAt: mtimeMs,
    messages
  }
}

async function scanAll(): Promise<ScannedSession[]> {
  const root = projectsDir()
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return []
  }
  const out: ScannedSession[] = []
  for (const dir of dirs) {
    let files: string[]
    try {
      files = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(root, dir, name)
      try {
        const st = await stat(file)
        if (!st.isFile()) continue
        let hit = cache.get(file)
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          hit = { mtimeMs: st.mtimeMs, size: st.size, info: await scanFile(file, st.mtimeMs) }
          cache.set(file, hit)
        }
        if (hit.info) out.push(hit.info)
      } catch (err) {
        console.warn('[sessions] could not read', file, err)
      }
    }
  }
  return out
}

function importedIds(): Set<string> {
  return new Set(db('sessions').list().flatMap((s) => (s.sdkSessionId ? [s.sdkSessionId] : [])))
}

export async function listCliSessions(): Promise<CliSessionInfo[]> {
  const known = importedIds()
  const all = await scanAll()
  // The same session id can appear twice if a project folder was renamed; keep the newest.
  const byId = new Map<string, ScannedSession>()
  for (const s of all) {
    const prev = byId.get(s.sdkSessionId)
    if (!prev || prev.updatedAt < s.updatedAt) byId.set(s.sdkSessionId, s)
  }
  return [...byId.values()]
    .map((s) => ({ ...s, imported: known.has(s.sdkSessionId) }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function importCliSessions(ids: string[]): Promise<ImportCliResult> {
  const wanted = new Set(ids)
  const known = importedIds()
  const available = await listCliSessions()
  let imported = 0
  let skipped = 0
  for (const info of available) {
    if (!wanted.has(info.sdkSessionId)) continue
    if (known.has(info.sdkSessionId)) {
      skipped++
      continue
    }
    const session: Session = {
      id: nanoid(),
      title: info.title,
      cwd: info.cwd,
      pinned: false,
      archived: false,
      unread: false,
      status: 'idle',
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      sdkSessionId: info.sdkSessionId
    }
    db('sessions').put(session)
    known.add(info.sdkSessionId)
    imported++
  }
  skipped += [...wanted].filter((id) => !available.some((s) => s.sdkSessionId === id)).length
  return { imported, skipped }
}
