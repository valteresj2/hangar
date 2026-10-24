// Rewind and fork from a user message.
//
// The anchor is the message's UUID in the Claude Code session: the `sdkUuid` we send with every prompt
// (older transcripts fall back to matching prompts by position).
// - Rewind keeps the same CLI session and resumes it at the entry just before the message
//   (`resumeSessionAt`, see points.ts); files can be restored from the SDK's checkpoints (`rewindFiles`).
// - Fork copies the CLI session up to the end of that message's turn (`forkSession`) into a new Hangar session.
import { randomUUID } from 'node:crypto'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { broadcast } from '../../core/broadcast'
import { db } from '../../core/store'
import type { Session } from '../../../shared/contracts'
import {
  ENGINE,
  type ForkResult,
  type PastedImage,
  type RewindOptions,
  type RewindPreview,
  type RewindResult,
  type TranscriptEntry
} from '../../../shared/features/engine'
import { promptTextFromUserContent, toolResultsFromUserContent } from './convert'
import { loadImage } from './images'
import { setRewindPoint } from './points'
import { closeRunner, existingRunner, history, runnerFor } from './registry'
import { loadSdk } from './sdk'
import { writeEntries } from './transcript'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

function sessionOf(sessionId: string): Session {
  const s = db('sessions').get(sessionId)
  if (!s) throw new Error('Sessão não encontrada.')
  return s
}

function cwdOf(s: Session): string {
  return s.worktree?.path ?? s.cwd
}

async function findUserEntry(sessionId: string, entryId: string): Promise<{ entries: TranscriptEntry[]; idx: number; entry: UserEntry }> {
  const entries = await history(sessionId)
  const idx = entries.findIndex((e) => e.id === entryId)
  const entry = entries[idx]
  if (!entry || entry.kind !== 'user') throw new Error('Mensagem não encontrada na transcrição.')
  return { entries, idx, entry }
}

function contentOf(m: SessionMessage): unknown {
  return (m.message as { content?: unknown } | undefined)?.content
}

/** A message the user typed (not a tool result, not a CLI-generated wrapper). */
function isPrompt(m: SessionMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id) return false
  const content = contentOf(m)
  if (toolResultsFromUserContent(content).length) return false
  const hasImage = Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === 'image')
  return !!promptTextFromUserContent(content) || hasImage
}

async function chainOf(s: Session): Promise<SessionMessage[]> {
  if (!s.sdkSessionId) return []
  const { getSessionMessages } = await loadSdk()
  return getSessionMessages(s.sdkSessionId, { dir: cwdOf(s) })
}

/** Index of the transcript's user entry in the CLI chain, or -1. */
function locate(chain: SessionMessage[], entries: TranscriptEntry[], idx: number): number {
  const entry = entries[idx] as UserEntry
  if (entry.sdkUuid) {
    const i = chain.findIndex((m) => m.uuid === entry.sdkUuid)
    if (i >= 0) return i
  }
  const k = entries.slice(0, idx).filter((e) => e.kind === 'user').length
  const prompts = chain.flatMap((m, i) => (isPrompt(m) ? [i] : []))
  return prompts[k] ?? -1
}

function assertIdle(sessionId: string): void {
  if (existingRunner(sessionId)?.state().busy) throw new Error('Pare a geração antes de voltar ou bifurcar.')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function rewindPreview(sessionId: string, entryId: string): Promise<RewindPreview> {
  const s = sessionOf(sessionId)
  const { entries, idx } = await findUserEntry(sessionId, entryId)
  const none = { canRewindFiles: false, filesChanged: [] }
  if (!s.sdkSessionId) return { canRewindConversation: true, ...none, filesError: 'Ainda não há sessão do Claude Code.' }
  const chain = await chainOf(s)
  const at = locate(chain, entries, idx)
  if (at < 0) return { canRewindConversation: false, ...none, filesError: 'Mensagem não encontrada na sessão do Claude Code.' }
  try {
    const r = await runnerFor(sessionId).rewindFiles(chain[at].uuid, true)
    if (!r.canRewind) return { canRewindConversation: true, ...none, filesError: r.error ?? 'Sem checkpoint de arquivos.' }
    return {
      canRewindConversation: true,
      canRewindFiles: true,
      filesChanged: r.filesChanged ?? [],
      insertions: r.insertions,
      deletions: r.deletions
    }
  } catch (err) {
    return { canRewindConversation: true, ...none, filesError: errorText(err) }
  }
}

export async function rewind(sessionId: string, entryId: string, opts: RewindOptions = {}): Promise<RewindResult> {
  assertIdle(sessionId)
  const s = sessionOf(sessionId)
  const { entries, idx, entry } = await findUserEntry(sessionId, entryId)
  const result: RewindResult = {
    text: entry.text,
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    ...(entry.output ? { output: entry.output } : {})
  }

  if (s.sdkSessionId) {
    const chain = await chainOf(s)
    const at = locate(chain, entries, idx)
    if (at < 0) throw new Error('Não encontrei esta mensagem na sessão do Claude Code.')

    if (opts.restoreFiles) {
      try {
        const runner = runnerFor(sessionId)
        const preview = await runner.rewindFiles(chain[at].uuid, true)
        if (!preview.canRewind) throw new Error(preview.error ?? 'Sem checkpoint de arquivos.')
        const done = await runner.rewindFiles(chain[at].uuid, false)
        if (!done.canRewind) throw new Error(done.error ?? 'Falha ao restaurar os arquivos.')
        result.filesRestored = preview.filesChanged ?? []
      } catch (err) {
        result.filesError = errorText(err)
      }
    }

    // The next query resumes right before the message; the first message sent there becomes the new branch.
    closeRunner(sessionId)
    if (at > 0) setRewindPoint(sessionId, chain[at - 1].uuid)
    else {
      setRewindPoint(sessionId, undefined)
      db('sessions').patch(sessionId, { sdkSessionId: undefined })
    }
  }

  writeEntries(sessionId, entries.slice(0, idx))
  db('sessions').patch(sessionId, { status: 'idle', updatedAt: Date.now() })
  broadcast(ENGINE.evReset, { sessionId })

  const images = (await Promise.all((entry.images ?? []).map(loadImage))).filter((i): i is PastedImage => !!i)
  if (images.length) result.images = images
  return result
}

export async function fork(sessionId: string, entryId: string): Promise<ForkResult> {
  assertIdle(sessionId)
  const s = sessionOf(sessionId)
  const { entries, idx } = await findUserEntry(sessionId, entryId)
  // Keep the message and the whole turn that answered it.
  let end = entries.findIndex((e, i) => i > idx && e.kind === 'user')
  if (end < 0) end = entries.length
  const title = `${s.title} (bifurcação)`

  let sdkSessionId: string | undefined
  const remap = new Map<string, string>()
  if (s.sdkSessionId) {
    const chain = await chainOf(s)
    const at = locate(chain, entries, idx)
    if (at < 0) throw new Error('Não encontrei esta mensagem na sessão do Claude Code.')
    const next = chain.findIndex((m, i) => i > at && isPrompt(m))
    const cut = (next < 0 ? chain.length : next) - 1
    const { forkSession, getSessionMessages } = await loadSdk()
    sdkSessionId = (await forkSession(s.sdkSessionId, { dir: cwdOf(s), upToMessageId: chain[cut].uuid, title })).sessionId
    // The fork gets fresh UUIDs in the same order; carry them over so the fork can be rewound/forked too.
    const forked = await getSessionMessages(sdkSessionId, { dir: cwdOf(s) })
    if (forked.length === cut + 1) forked.forEach((m, i) => remap.set(chain[i].uuid, m.uuid))
  }

  const id = randomUUID()
  const copy = entries.slice(0, end).map((e) =>
    e.kind === 'user' && e.sdkUuid ? { ...e, sdkUuid: remap.get(e.sdkUuid) } : e
  ) as TranscriptEntry[]
  writeEntries(id, copy)

  const now = Date.now()
  db('sessions').put({
    ...s,
    id,
    title,
    sdkSessionId,
    status: 'idle',
    unread: false,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now
  })
  broadcast(ENGINE.evSelect, { sessionId: id })
  return { sessionId: id }
}
