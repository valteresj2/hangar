// Runner registry and the session-level operations shared by the IPC handlers and api.ts.
import { db } from '../../core/store'
import type { EngineState, SlashCommandInfo, TranscriptEntry } from '../../../shared/features/engine'
import { fromAssistantContent, promptTextFromUserContent, toolResultsFromUserContent, type EntryDraft } from './convert'
import { Runner } from './runner'
import { HangarRunner } from './hangar/runner'
import { effectiveProviderId, profiles, providerInfo } from './providers'
import type { SessionEngine } from '../../../shared/providers'
import { loadSdk, probeCommands } from './sdk'
import { appendEntries, makeEntry, readEntries, transcriptExists } from './transcript'

/** A session is driven by Claude Code (Runner) or by the Hangar Harness (HangarRunner); both have the same surface. */
export type SessionRunner = Runner | HangarRunner

const runners = new Map<string, SessionRunner>()
let activeSessionId: string | undefined

const host = { isActive: (id: string) => id === activeSessionId }

/** The engine of the profile a session runs under (the profile decides; see ProviderProfile.engine). */
export function engineOf(sessionId: string): SessionEngine {
  const id = effectiveProviderId(db('sessions').get(sessionId))
  return profiles().find((p) => p.id === id)?.engine === 'hangar' ? 'hangar' : 'claude'
}

export function runnerFor(sessionId: string): SessionRunner {
  let r = runners.get(sessionId)
  if (!db('sessions').get(sessionId)) throw new Error(`Sessão ${sessionId} não encontrada`)
  const engine = engineOf(sessionId)
  // The profile's engine changed since this runner was made (edited in Settings): replace it between turns.
  if (r && r.engine !== engine && !r.state().busy) {
    r.close()
    runners.delete(sessionId)
    r = undefined
  }
  if (!r) {
    r = engine === 'hangar' ? new HangarRunner(sessionId, host) : new Runner(sessionId, host)
    runners.set(sessionId, r)
  }
  return r
}

export function existingRunner(sessionId: string): SessionRunner | undefined {
  return runners.get(sessionId)
}

export function setActive(sessionId: string | undefined): void {
  activeSessionId = sessionId
  const s = sessionId ? db('sessions').get(sessionId) : undefined
  if (s?.unread) db('sessions').patch(s.id, { unread: false })
}

export function closeRunner(sessionId: string): void {
  runners.get(sessionId)?.close()
  runners.delete(sessionId)
}

export function closeAll(): void {
  for (const r of runners.values()) r.close()
  runners.clear()
}

export function stateOf(sessionId: string): EngineState {
  return (
    runners.get(sessionId)?.state() ?? { running: false, busy: false, pending: [], streamText: '', streamThinking: '' }
  )
}

export async function slashCommandsFor(sessionId: string): Promise<SlashCommandInfo[]> {
  const r = runners.get(sessionId)
  if (r?.commands.length) return r.commands
  const s = db('sessions').get(sessionId)
  if (!s) return []
  // Slash commands belong to Claude Code; a Hangar-engine session has none (and must not start a CLI to ask).
  if (engineOf(sessionId) === 'hangar') return []
  try {
    return await probeCommands(s.worktree?.path ?? s.cwd, effectiveProviderId(s))
  } catch {
    return []
  }
}

/**
 * Moves a session to another provider profile. The running query ends; the next message resumes the same
 * conversation (`resume`) under the new profile.
 */
export function switchProvider(sessionId: string, providerId: string): void {
  const s = db('sessions').get(sessionId)
  if (!s) throw new Error(`Sessão ${sessionId} não encontrada`)
  if (runners.get(sessionId)?.state().busy) throw new Error('Pare a geração antes de trocar de provedor.')
  if (effectiveProviderId(s) === providerId && s.providerId) return
  db('sessions').patch(sessionId, { providerId })
  const name = providerInfo(providerId).name
  const runner = runnerFor(sessionId)
  runner.note(
    `Provedor alterado para "${name}". A conversa continua com o mesmo histórico, mas o cache de prompt recomeça (a próxima rodada pode ser mais lenta e cara).`
  )
  closeRunner(sessionId)
}

/**
 * History of a session. Sessions imported from the Claude Code CLI have no Hangar transcript yet:
 * build one from the CLI's own JSONL (via the SDK) the first time they are opened.
 */
export async function history(sessionId: string): Promise<TranscriptEntry[]> {
  if (transcriptExists(sessionId)) return readEntries(sessionId)
  const s = db('sessions').get(sessionId)
  if (!s?.sdkSessionId) return []
  try {
    const { getSessionMessages } = await loadSdk()
    const messages = await getSessionMessages(s.sdkSessionId, { dir: s.worktree?.path ?? s.cwd })
    const drafts: EntryDraft[] = []
    for (const m of messages) {
      if (m.parent_tool_use_id) continue
      const content = (m.message as { content?: unknown } | undefined)?.content
      if (m.type === 'assistant') drafts.push(...fromAssistantContent(content))
      else if (m.type === 'user') {
        const results = toolResultsFromUserContent(content)
        if (results.length) drafts.push(...results)
        else {
          const text = promptTextFromUserContent(content)
          if (text) drafts.push({ kind: 'user', text })
        }
      }
    }
    const base = s.createdAt || Date.now()
    const entries = drafts.map((d, i) => makeEntry(d, base + i))
    appendEntries(sessionId, entries)
    return entries
  } catch {
    return []
  }
}
