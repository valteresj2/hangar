// Main-side API of the engine feature, used by other features. Owned by the engine agent.
import type { SendOptions, TranscriptEntry } from '../../../shared/features/engine'
import { existingRunner, history, runnerFor } from './registry'
import { searchEntries } from './transcript'

/**
 * Sends a prompt to the session, starting (or resuming) its Claude Code query if needed. Resolves once queued.
 * `opts.output: 'motion'` asks for a Hangar Motion animation (the authoring guide goes along, hidden).
 */
export async function sendPrompt(sessionId: string, text: string, opts?: SendOptions): Promise<void> {
  await runnerFor(sessionId).send(text, opts)
}

export async function interrupt(sessionId: string): Promise<void> {
  await existingRunner(sessionId)?.interrupt()
}

export async function readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  return history(sessionId)
}

export async function searchTranscripts(query: string): Promise<{ sessionId: string; snippet: string }[]> {
  return searchEntries(query)
}
