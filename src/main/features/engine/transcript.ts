// Transcript persistence: one JSONL file per Hangar session in <userData>/hangar-data/engine/transcripts/.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SearchHit, TranscriptEntry } from '../../../shared/features/engine'
import type { EntryDraft } from './convert'

let dirCache: string | undefined

function transcriptsDir(): string {
  if (!dirCache) {
    dirCache = join(app.getPath('userData'), 'hangar-data', 'engine', 'transcripts')
    if (!existsSync(dirCache)) mkdirSync(dirCache, { recursive: true })
  }
  return dirCache
}

function fileFor(sessionId: string): string {
  // Session ids come from the renderer; never let them escape the directory.
  return join(transcriptsDir(), `${sessionId.replace(/[^\w-]/g, '_')}.jsonl`)
}

export function transcriptExists(sessionId: string): boolean {
  return existsSync(fileFor(sessionId))
}

export function makeEntry(draft: EntryDraft, ts = Date.now()): TranscriptEntry {
  return { ...draft, id: randomUUID(), ts } as TranscriptEntry
}

export function appendEntries(sessionId: string, entries: TranscriptEntry[]): void {
  if (entries.length === 0) return
  appendFileSync(fileFor(sessionId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

/** Replaces the whole transcript (rewind, fork copies). Atomic: tmp file + rename. */
export function writeEntries(sessionId: string, entries: TranscriptEntry[]): void {
  const file = fileFor(sessionId)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8')
  renameSync(tmp, file)
}

function parseLines(raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // A torn last line after a crash is skipped rather than failing the whole history.
    }
  }
  return out
}

export async function readEntries(sessionId: string): Promise<TranscriptEntry[]> {
  try {
    return parseLines(await readFile(fileFor(sessionId), 'utf8'))
  } catch {
    return []
  }
}

function searchableText(e: TranscriptEntry): string | undefined {
  if (e.kind === 'user' || e.kind === 'assistant') return e.text
  return undefined
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50)
  const end = Math.min(text.length, index + length + 70)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** Case-insensitive search over user/assistant text; one hit (the first) per session. */
export async function searchEntries(query: string, limit = 50): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  let files: string[] = []
  try {
    files = (await readdir(transcriptsDir())).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  for (const file of files) {
    if (hits.length >= limit) break
    let raw: string
    try {
      raw = await readFile(join(transcriptsDir(), file), 'utf8')
    } catch {
      continue
    }
    if (!raw.toLowerCase().includes(needle)) continue
    for (const entry of parseLines(raw)) {
      const text = searchableText(entry)
      const idx = text?.toLowerCase().indexOf(needle) ?? -1
      if (text && idx >= 0) {
        hits.push({ sessionId: file.slice(0, -'.jsonl'.length), snippet: snippetAround(text, idx, needle.length) })
        break
      }
    }
  }
  return hits
}
