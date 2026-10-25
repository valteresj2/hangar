// Main-side API of the engine feature, used by other features. Owned by the engine agent.
import type { SendOptions, TranscriptEntry } from '../../../shared/features/engine'
import { closeRunner, existingRunner, history, runnerFor, switchProvider } from './registry'
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

/** Ends the session's Claude Code process (the session stays; the next prompt resumes it). */
export async function closeSession(sessionId: string): Promise<void> {
  closeRunner(sessionId)
}

export async function readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  return history(sessionId)
}

export async function searchTranscripts(query: string): Promise<{ sessionId: string; snippet: string }[]> {
  return searchEntries(query)
}

/** Whether the session has a Claude Code process (`running`) and whether it is mid-turn (`busy`). */
export function sessionState(sessionId: string): { running: boolean; busy: boolean } {
  const state = existingRunner(sessionId)?.state()
  return { running: !!state?.running, busy: !!state?.busy }
}

/** Adds an informational note to the session's transcript (shown to the user, not sent to Claude). */
export function noteSession(sessionId: string, text: string): void {
  runnerFor(sessionId).note(text)
}

/** Moves the session to another provider profile: notes it, ends the process; the next prompt resumes there. */
export function switchSessionProvider(sessionId: string, providerId: string): void {
  switchProvider(sessionId, providerId)
}

/** Changes the session's model (applied to the running process when there is one). */
export async function setSessionModel(sessionId: string, model: string): Promise<void> {
  await runnerFor(sessionId).setOptions({ model })
}
