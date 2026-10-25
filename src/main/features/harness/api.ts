// Main-side API of the harness feature, used by the lab feature. Owned by the harness agent.
import { nanoid } from 'nanoid'
import type {
  HarnessSnapshot,
  HarnessTree,
  Lesson,
  ReflectInput,
  ReflectResult,
  Reflection,
  SnapshotSource
} from '../../../shared/harness'
import { HARNESS, type HarnessChange } from '../../../shared/features/harness'
import { broadcast } from '../../core/broadcast'
import { getLessons, getSnapshots, normalizeProject, putLesson, putReflection, putSnapshot } from './data'
import { buildPrompt, parseReflection, runReflector, type ParsedReflection } from './reflector'
import { readTree, syncTree } from './tree'

/** Reads the project's harness files (see HARNESS_PATTERNS). */
export async function readHarness(cwd: string): Promise<HarnessTree> {
  return readTree(cwd)
}

/** Makes `dir` contain exactly `tree` on the harness surface (adds, updates and deletes harness files only). */
export async function writeHarness(dir: string, tree: HarnessTree): Promise<void> {
  await syncTree(dir, tree)
  const change: HarnessChange = { dir: normalizeProject(dir), what: 'files' }
  broadcast(HARNESS.evChanged, change)
}

export async function listSnapshots(projectCwd: string): Promise<HarnessSnapshot[]> {
  return getSnapshots(projectCwd)
}

export async function createSnapshot(
  projectCwd: string,
  label: string,
  source: SnapshotSource,
  tree?: HarnessTree,
  note?: string
): Promise<HarnessSnapshot> {
  const project = normalizeProject(projectCwd)
  const snapshot: HarnessSnapshot = {
    id: nanoid(10),
    projectCwd: project,
    label: label.trim() || 'Snapshot',
    source,
    createdAt: Date.now(),
    parentId: getSnapshots(project)[0]?.id,
    tree: tree ?? (await readTree(project))
  }
  if (note) snapshot.note = note
  putSnapshot(snapshot)
  return snapshot
}

export async function listLessons(projectCwd: string): Promise<Lesson[]> {
  return getLessons(projectCwd)
}

/** Runs the reflector without storing anything; used by both reflect() and the session proposal flow. */
export async function runReflection(
  input: ReflectInput,
  model?: string
): Promise<{ parsed: ParsedReflection; raw: string }> {
  const raw = await runReflector(buildPrompt(input), model)
  return { parsed: parseReflection(raw), raw }
}

export function toLesson(
  projectCwd: string,
  exp: NonNullable<ParsedReflection['experience']>,
  source: Lesson['source']
): Lesson {
  return {
    id: nanoid(10),
    projectCwd: normalizeProject(projectCwd),
    cue: exp.cue,
    lesson: exp.lesson,
    evidence: exp.evidence,
    confidence: exp.confidence,
    createdAt: Date.now(),
    enabled: true,
    source
  }
}

/** Runs the reflector (edit rows + at most one lesson) and stores the result. */
export async function reflect(input: ReflectInput): Promise<ReflectResult> {
  const project = normalizeProject(input.projectCwd)
  const { parsed } = await runReflection(input)
  const lesson = parsed.experience ? putLesson(toLesson(project, parsed.experience, input.source)) : undefined
  const reflection: Reflection = {
    id: nanoid(10),
    projectCwd: project,
    createdAt: Date.now(),
    edits: parsed.edits,
    source: input.source
  }
  if (lesson) reflection.lessonId = lesson.id
  putReflection(reflection)
  return { reflection, lesson }
}
