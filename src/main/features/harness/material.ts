// Material for the reflector: a condensed trajectory from an engine transcript and the git change record
// of a working directory.

import { execFile } from 'node:child_process'
import type { TranscriptEntry } from '../../../shared/features/engine'

const TRAJECTORY_MAX = 30_000
const CHANGES_MAX = 12_000

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)} … [+${t.length - max} chars]` : t
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max)
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const main = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('url') ?? pick('description') ?? pick('prompt')
  if (main) return oneLine(main, 300)
  if (name === 'TodoWrite') return 'updated the todo list'
  return oneLine(JSON.stringify(input), 300)
}

/** User requests, tool calls, errors and the final answer, limited to ~30k characters. */
export function condenseTrajectory(entries: TranscriptEntry[]): { text: string; task: string; costUsd?: number; durationMs?: number } {
  const lines: string[] = []
  let task = ''
  let finalAnswer = ''
  let costUsd: number | undefined
  let durationMs = 0
  const toolNames = new Map<string, string>()

  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        if (!task) task = e.text
        lines.push(`USER: ${clip(e.text, 2000)}`)
        break
      case 'assistant':
        if (e.parentToolUseId || !e.text.trim()) break
        finalAnswer = e.text
        lines.push(`ASSISTANT: ${clip(e.text, 1200)}`)
        break
      case 'tool_use':
        toolNames.set(e.toolUseId, e.name)
        lines.push(`${e.parentToolUseId ? '  (subagent) ' : ''}TOOL ${e.name}: ${summarizeInput(e.name, e.input)}`)
        break
      case 'tool_result':
        if (e.isError) lines.push(`  TOOL ERROR (${toolNames.get(e.toolUseId) ?? 'tool'}): ${oneLine(e.content, 600)}`)
        break
      case 'permission_decision':
        if (e.decision === 'deny') lines.push(`PERMISSION DENIED${e.message ? `: ${oneLine(e.message, 300)}` : ''}`)
        break
      case 'result':
        costUsd = e.costUsd
        durationMs += e.durationMs
        lines.push(`TURN END: ${e.isError ? 'error' : 'ok'} · ${Math.round(e.durationMs / 1000)} s${e.errors?.length ? ` · ${oneLine(e.errors.join('; '), 400)}` : ''}`)
        break
      case 'error':
        lines.push(`ERROR: ${oneLine(e.message, 600)}`)
        break
      default:
        break
    }
  }

  let text = lines.join('\n')
  const final = finalAnswer ? `\n\nFINAL ANSWER:\n${clip(finalAnswer, 6000)}` : ''
  const budget = TRAJECTORY_MAX - final.length
  if (text.length > budget) {
    // Keep the start (the request and first moves) and the end (how it finished).
    const head = Math.floor(budget * 0.3)
    const tail = budget - head - 80
    text = `${text.slice(0, head)}\n… [${text.length - head - tail} characters of the middle omitted] …\n${text.slice(-tail)}`
  }
  return { text: text + final, task, costUsd, durationMs: durationMs || undefined }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  })
}

/** `git diff --stat` + untracked files + a diff excerpt of the working directory against HEAD. */
export async function gitChanges(dir: string): Promise<string> {
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return '(not a git repository: no change record)'
  }
  const [stat, status, diff] = await Promise.all([
    git(dir, ['diff', '--stat', 'HEAD']).catch(() => ''),
    git(dir, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''),
    git(dir, ['diff', 'HEAD', '--no-color', '--unified=2']).catch(() => '')
  ])
  const untracked = status
    .split(/\r?\n/)
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3))
  const parts = [
    stat.trim() ? `git diff --stat HEAD:\n${stat.trim()}` : 'No tracked file changed against HEAD.',
    untracked.length ? `Untracked files:\n${untracked.slice(0, 50).join('\n')}${untracked.length > 50 ? `\n… +${untracked.length - 50}` : ''}` : '',
    diff.trim() ? `Diff excerpt:\n${clip(diff, CHANGES_MAX)}` : ''
  ]
  return parts.filter(Boolean).join('\n\n')
}
