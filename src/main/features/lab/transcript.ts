// Reading a variant's run out of its engine transcript: outcome, final answer, condensed trajectory.
import type { TranscriptEntry } from '../../../shared/features/engine'

type Entry<K extends TranscriptEntry['kind']> = Extract<TranscriptEntry, { kind: K }>

const FINAL_ANSWER_LIMIT = 12_000
const TRAJECTORY_LIMIT = 12_000

export interface RunOutcome {
  /** A result entry exists after the lab prompt. */
  finished: boolean
  isError: boolean
  costUsd?: number
  durationMs?: number
  errors: string[]
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Entries of the lab run: from the first user prompt on (follow-ups by the user count too). */
function runEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const first = entries.findIndex((e) => e.kind === 'user')
  return first < 0 ? [] : entries.slice(first)
}

export function outcomeOf(entries: TranscriptEntry[]): RunOutcome {
  const run = runEntries(entries)
  const results = run.filter((e): e is Entry<'result'> => e.kind === 'result')
  const last = results[results.length - 1]
  const lastUser = run.map((e) => e.kind).lastIndexOf('user')
  const finished = !!last && run.indexOf(last) > lastUser
  const errors = [
    ...run.filter((e): e is Entry<'error'> => e.kind === 'error').map((e) => e.message),
    ...results.flatMap((r) => r.errors ?? [])
  ]
  return {
    finished,
    isError: !!last?.isError,
    // costUsd is cumulative for the live query; durations add up per turn.
    costUsd: last?.costUsd,
    durationMs: results.length ? results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) : undefined,
    errors: [...new Set(errors)].slice(0, 10)
  }
}

/** The last top-level assistant message of the run. */
export function finalAnswerOf(entries: TranscriptEntry[]): string {
  const run = runEntries(entries)
  for (let i = run.length - 1; i >= 0; i--) {
    const e = run[i]
    if (e.kind === 'assistant' && !e.parentToolUseId && e.text.trim()) return clip(e.text.trim(), FINAL_ANSWER_LIMIT)
  }
  return ''
}

function toolSummary(e: Entry<'tool_use'>): string {
  const input = e.input
  const key = ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'prompt'].find(
    (k) => typeof input[k] === 'string'
  )
  return key ? `${e.name} ${clip(String(input[key]).replace(/\s+/g, ' '), 160)}` : e.name
}

/** User requests, tool calls (and, with `withResults`, short tool outputs), errors and the final answer. */
export function condenseTrajectory(entries: TranscriptEntry[], limit = TRAJECTORY_LIMIT, withResults = false): string {
  const lines: string[] = []
  for (const e of runEntries(entries)) {
    if (e.kind === 'user') lines.push(`USER: ${clip(e.text, 1500)}`)
    else if (e.kind === 'tool_use' && !e.parentToolUseId) lines.push(`TOOL: ${toolSummary(e)}`)
    else if (e.kind === 'tool_result' && e.isError) lines.push(`TOOL ERROR: ${clip(e.content, 300)}`)
    else if (e.kind === 'tool_result' && withResults) lines.push(`  -> ${clip(e.content.replace(/\s+/g, ' '), 300)}`)
    else if (e.kind === 'error') lines.push(`ERROR: ${clip(e.message, 300)}`)
    else if (e.kind === 'permission_request') lines.push(`PERMISSION ASKED: ${e.request.toolName}`)
    else if (e.kind === 'assistant' && !e.parentToolUseId) lines.push(`ASSISTANT: ${clip(e.text, 400)}`)
    else if (e.kind === 'result') {
      lines.push(
        `RESULT: ${e.subtype}${e.isError ? ' (error)' : ''}, ${e.numTurns} turns, ${Math.round(e.durationMs / 1000)}s`
      )
    }
  }
  const final = finalAnswerOf(entries)
  let text = lines.join('\n')
  if (text.length > limit) {
    // Keep the start (what was asked, first moves) and the end (how it finished).
    const half = Math.floor(limit / 2)
    text = `${text.slice(0, half)}\n… [trajectory condensed] …\n${text.slice(-half)}`
  }
  return final ? `${text}\n\nFINAL ANSWER:\n${clip(final, 4000)}` : text
}
