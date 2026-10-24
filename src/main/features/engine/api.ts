// Main-side API of the engine feature, used by other features. Owned by the engine agent.
import type { TranscriptEntry } from '../../../shared/features/engine'

export async function sendPrompt(_sessionId: string, _text: string, _opts?: { attachments?: string[] }): Promise<void> {
  throw new Error('engine.sendPrompt not implemented yet')
}

export async function interrupt(_sessionId: string): Promise<void> {}

export async function readTranscript(_sessionId: string): Promise<TranscriptEntry[]> {
  return []
}

export async function searchTranscripts(_query: string): Promise<{ sessionId: string; snippet: string }[]> {
  return []
}
