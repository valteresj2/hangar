// System-prompt appendix with the project's active lessons. The provider is synchronous: lessons come
// from data.ts's in-memory cache (loaded synchronously on first access).

import type { Session } from '../../../shared/contracts'
import type { Lesson, LessonConfidence } from '../../../shared/harness'
import { getLessons } from './data'

const MAX_LESSONS = 8
const MAX_CHARS = 4000
const RANK: Record<LessonConfidence, number> = { high: 0, medium: 1, low: 2 }

/** The directory whose lessons apply to a session: its project, not a worktree copy. */
export function projectOf(session: Session): string {
  return session.worktree?.baseCwd ?? session.cwd
}

function line(l: Lesson): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  return `- When ${flat(l.cue).replace(/^when\s+/i, '')}: ${flat(l.lesson)} (confidence: ${l.confidence})`
}

export function lessonsBlock(projectCwd: string): string | undefined {
  const active = getLessons(projectCwd)
    .filter((l) => l.enabled)
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || b.createdAt - a.createdAt)
  if (!active.length) return undefined
  const head = 'Lessons from earlier work in this project (hypotheses — verify before relying on them):'
  const out = [head]
  let used = head.length
  for (const l of active.slice(0, MAX_LESSONS)) {
    const text = line(l)
    if (used + text.length + 1 > MAX_CHARS) break
    out.push(text)
    used += text.length + 1
  }
  return out.length > 1 ? out.join('\n') : undefined
}

export function sessionLessons(session: Session): string | undefined {
  return lessonsBlock(projectOf(session))
}
