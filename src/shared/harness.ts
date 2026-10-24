// Harness Lab contracts, shared by the "harness" (phase 1) and "lab" (phase 2) features.
// Owned by the chief. Ideas adapted from google-research/harness2 (Apache-2.0): the harness is the
// editable system around the model; experience is recorded as per-edit verdicts plus at most one
// transferable lesson; variants are compared blind, with "keep the base" as a valid outcome.

/** Project-relative path -> file content. Paths always use forward slashes. */
export type HarnessTree = Record<string, string>

/**
 * The project-level Claude Code harness surface. Anything else in the project is NOT harness.
 *   CLAUDE.md, .claude/CLAUDE.md          always-on instructions / memory / guardrails
 *   .claude/skills/<name>/**              skills (SKILL.md + scripts/resources)
 *   .claude/agents/<name>.md              subagents
 *   .claude/commands/**.md                slash commands
 *   .claude/settings.json                 hooks and permissions (shared settings)
 *   .claude/scripts/**                    helper scripts referenced by skills/hooks
 */
export const HARNESS_PATTERNS: readonly RegExp[] = [
  /^CLAUDE\.md$/,
  /^\.claude\/CLAUDE\.md$/,
  /^\.claude\/skills\/[A-Za-z0-9_.-]+\/.+$/,
  /^\.claude\/agents\/[A-Za-z0-9_.-]+\.md$/,
  /^\.claude\/commands\/.+\.md$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/scripts\/.+$/
]

export function isHarnessPath(rel: string): boolean {
  const r = rel.replace(/\\/g, '/')
  if (r.startsWith('/') || r.split('/').includes('..')) return false
  return HARNESS_PATTERNS.some((p) => p.test(r))
}

/** Component kind of a harness path (for grouping in the UI and in edit rows). */
export type HarnessComponentKind = 'instructions' | 'skill' | 'subagent' | 'command' | 'settings' | 'script'

export function componentOf(rel: string): { kind: HarnessComponentKind; name: string } | undefined {
  const r = rel.replace(/\\/g, '/')
  if (r === 'CLAUDE.md' || r === '.claude/CLAUDE.md') return { kind: 'instructions', name: r }
  let m = /^\.claude\/skills\/([^/]+)\//.exec(r)
  if (m) return { kind: 'skill', name: m[1] }
  m = /^\.claude\/agents\/([^/]+)\.md$/.exec(r)
  if (m) return { kind: 'subagent', name: m[1] }
  if (/^\.claude\/commands\//.test(r)) return { kind: 'command', name: r.slice('.claude/commands/'.length) }
  if (r === '.claude/settings.json') return { kind: 'settings', name: r }
  if (/^\.claude\/scripts\//.test(r)) return { kind: 'script', name: r.slice('.claude/scripts/'.length) }
  return undefined
}

export type SnapshotSource = 'manual' | 'lab' | 'reflect' | 'restore'

export interface HarnessSnapshot {
  id: string
  /** Project directory the harness belongs to (normalized absolute path). */
  projectCwd: string
  label: string
  source: SnapshotSource
  createdAt: number
  parentId?: string
  tree: HarnessTree
  /** Free-form note (e.g. which lab round adopted it). */
  note?: string
}

export type EditVerdict = 'helped' | 'hurt' | 'no observed effect' | 'confounded'

/** One row of "what each edit did" (harness2 experience format). */
export interface EditRow {
  component: string
  candidates: string
  change: string
  observed: string
  verdict: EditVerdict
}

export type LessonConfidence = 'high' | 'medium' | 'low'

/** A transferable lesson: when (`cue`) to do what (`lesson`) to which component, and why (`evidence`). */
export interface Lesson {
  id: string
  projectCwd: string
  cue: string
  lesson: string
  evidence: string
  confidence: LessonConfidence
  createdAt: number
  /** Lessons can be switched off without deleting them. */
  enabled: boolean
  source: { kind: 'session'; sessionId: string } | { kind: 'lab'; roundId: string } | { kind: 'manual' }
}

/** A reflection record: the edit rows and the optional lesson it produced. */
export interface Reflection {
  id: string
  projectCwd: string
  createdAt: number
  edits: EditRow[]
  /** Undefined when the reflector answered NO_ENTRY. */
  lessonId?: string
  source: Lesson['source']
}

/** One candidate handed to the reflector (from a lab round, or a single session vs its base). */
export interface ReflectCandidate {
  label: string
  tree: HarnessTree
  /** Condensed transcript: user requests, tool calls, errors, final answer. */
  trajectory: string
  /** `git diff --stat` + short diff excerpt of what the run changed. */
  changes: string
  costUsd?: number
  durationMs?: number
  adopted: boolean
}

export interface ReflectInput {
  projectCwd: string
  task: string
  baseTree: HarnessTree
  candidates: ReflectCandidate[]
  source: Lesson['source']
}

export interface ReflectResult {
  reflection: Reflection
  lesson?: Lesson
}

// ---- Lab (phase 2) ----

export type LabRoundStatus = 'preparing' | 'running' | 'selecting' | 'decided' | 'failed' | 'cancelled'

export interface LabVariant {
  /** Stable internal id ("base", "v1", …). Never shown during blind selection. */
  id: string
  /** Human label ("Base", "Snapshot: …", "Rascunho 1"). */
  label: string
  tree: HarnessTree
  snapshotId?: string
  sessionId?: string
  worktreePath?: string
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  costUsd?: number
  durationMs?: number
}

export interface LabRound {
  id: string
  projectCwd: string
  task: string
  model?: string
  status: LabRoundStatus
  createdAt: number
  variants: LabVariant[]
  /** Shuffled anonymous ids shown to the selector: anonId -> variant id. */
  blindMap?: Record<string, string>
  selection?: {
    by: 'user' | 'claude'
    anonId: string
    variantId: string
    why: string
  }
  adoptedSnapshotId?: string
  reflectionId?: string
}

/** Lab rounds: base + 1..MAX_LAB_VARIANTS variants. */
export const MAX_LAB_VARIANTS = 4
export const DEFAULT_LAB_VARIANTS = 2
