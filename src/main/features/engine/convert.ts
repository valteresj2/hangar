// Converts Anthropic message content (as delivered by the Agent SDK) into transcript entry drafts.
import type { Question, TranscriptEntry } from '../../../shared/features/engine'

/** A transcript entry before it gets an id and timestamp. */
export type EntryDraft = {
  [K in TranscriptEntry['kind']]: Omit<Extract<TranscriptEntry, { kind: K }>, 'id' | 'ts'>
}[TranscriptEntry['kind']]

/** Tool results are capped so a huge Bash output does not bloat the transcript file. */
const MAX_RESULT_CHARS = 30_000

type Block = { type?: string; [key: string]: unknown }

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as Block[]) : []
}

export function toolResultText(content: unknown): string {
  const text = blocks(content)
    .map((b) => {
      if (b.type === 'text') return String(b.text ?? '')
      if (b.type === 'image') return '[imagem]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (saída truncada)` : text
}

export function fromAssistantContent(content: unknown, parentToolUseId?: string): EntryDraft[] {
  const out: EntryDraft[] = []
  for (const b of blocks(content)) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      out.push({ kind: 'assistant', text: b.text, ...(parentToolUseId ? { parentToolUseId } : {}) })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      out.push({ kind: 'thinking', text: b.thinking })
    } else if (b.type === 'tool_use' && typeof b.id === 'string') {
      out.push({
        kind: 'tool_use',
        toolUseId: b.id,
        name: String(b.name ?? 'tool'),
        input: (b.input as Record<string, unknown>) ?? {},
        ...(parentToolUseId ? { parentToolUseId } : {})
      })
    }
  }
  return out
}

/** Tool results carried by a user message (the prompt text itself is recorded by the runner). */
export function toolResultsFromUserContent(content: unknown): EntryDraft[] {
  const out: EntryDraft[] = []
  for (const b of blocks(content)) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({
        kind: 'tool_result',
        toolUseId: b.tool_use_id,
        content: toolResultText(b.content),
        isError: b.is_error === true
      })
    }
  }
  return out
}

/** Text the user typed, skipping CLI-generated wrappers (local command output, caveats, reminders). */
export function promptTextFromUserContent(content: unknown): string | undefined {
  const text = blocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .filter(
      (t) => !/^\s*<(local-command|command-|system-reminder|hangar-output-mode)/.test(t) && !t.startsWith('Caveat:')
    )
    .join('\n')
    .trim()
  return text || undefined
}

export function parseQuestions(input: Record<string, unknown>): Question[] | undefined {
  const raw = input.questions
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
    .map((q) => ({
      question: String(q.question ?? ''),
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
            .map((o) => ({
              label: String(o.label ?? ''),
              description: typeof o.description === 'string' ? o.description : undefined
            }))
        : []
    }))
}

/** File path written by a successful file tool call, if any. */
export function writtenPath(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit')
    return typeof input.file_path === 'string' ? input.file_path : undefined
  if (name === 'NotebookEdit') return typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  return undefined
}
