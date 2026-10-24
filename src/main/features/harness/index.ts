// Feature "harness" — main process side. Owned by the harness agent.
// The project's harness surface (components), snapshots, lessons and the session reflector.

import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { nanoid } from 'nanoid'
import { structuredPatch } from 'diff'
import type { HarnessTree, Lesson, ReflectInput, Reflection } from '../../../shared/harness'
import { isHarnessPath } from '../../../shared/harness'
import {
  HARNESS,
  templateFiles,
  validTemplateName,
  type HarnessChange,
  type LessonPatch,
  type ReflectProposal,
  type ReflectSessionOptions,
  type TemplateKind,
  type TreeDiffFile
} from '../../../shared/features/harness'
import { broadcast } from '../../core/broadcast'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { registerSystemAppend } from '../../core/prompts'
import { db } from '../../core/store'
import { readTranscript } from '../engine/api'
import { createSnapshot, runReflection, toLesson, writeHarness } from './api'
import {
  getLessons,
  getReflections,
  getSnapshot,
  getSnapshots,
  normalizeProject,
  putLesson,
  putReflection,
  removeLesson,
  removeSnapshot
} from './data'
import { projectOf, sessionLessons } from './lessons'
import { condenseTrajectory, gitChanges } from './material'
import { assertHarnessPath, deleteHarnessFile, readHarnessState, readTree, writeHarnessFile } from './tree'

function filesChanged(dir: string): void {
  const change: HarnessChange = { dir: normalizeProject(dir), what: 'files' }
  broadcast(HARNESS.evChanged, change)
}

async function createFromTemplate(dir: string, kind: TemplateKind, name = ''): Promise<string[]> {
  if (!templateFiles(kind, 'x')) throw new Error(`Modelo desconhecido: ${kind}`)
  if (['skill', 'subagent', 'command', 'script'].includes(kind) && !validTemplateName(kind, name.trim())) {
    throw new Error('Nome inválido: use letras, números, ponto, hífen ou sublinhado.')
  }
  const files = templateFiles(kind, name)
  for (const rel of Object.keys(files)) {
    assertHarnessPath(rel)
    if (existsSync(join(dir, rel))) throw new Error(`Já existe: ${rel}`)
  }
  for (const [rel, content] of Object.entries(files)) await writeHarnessFile(dir, rel, content)
  filesChanged(dir)
  return Object.keys(files)
}

export function diffTrees(from: HarnessTree, to: HarnessTree): TreeDiffFile[] {
  const paths = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
  const out: TreeDiffFile[] = []
  for (const path of paths) {
    const a = from[path]
    const b = to[path]
    if (a === b) continue
    const patch = structuredPatch(path, path, a ?? '', b ?? '', '', '', { context: 3 })
    let additions = 0
    let deletions = 0
    const hunks = patch.hunks.map((h) => {
      let oldNo = h.oldStart
      let newNo = h.newStart
      const lines = h.lines
        .filter((l) => !l.startsWith('\\'))
        .map((l) => {
          const text = l.slice(1)
          if (l[0] === '+') {
            additions++
            return { type: 'add' as const, text, newNo: newNo++ }
          }
          if (l[0] === '-') {
            deletions++
            return { type: 'del' as const, text, oldNo: oldNo++ }
          }
          return { type: 'ctx' as const, text, oldNo: oldNo++, newNo: newNo++ }
        })
      return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines }
    })
    out.push({ path, status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', additions, deletions, hunks })
  }
  return out
}

async function restoreSnapshot(projectCwd: string, snapshotId: string, dir?: string) {
  const project = normalizeProject(projectCwd)
  const snap = getSnapshot(project, snapshotId)
  if (!snap) throw new Error('Snapshot não encontrado.')
  const target = dir ?? project
  const backup = await createSnapshot(project, `Antes de restaurar “${snap.label}”`, 'restore', await readTree(target))
  await writeHarness(target, snap.tree)
  return backup
}

async function reflectSession(sessionId: string, opts: ReflectSessionOptions = {}): Promise<ReflectProposal> {
  const session = db('sessions').get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const project = normalizeProject(projectOf(session))
  const dir = session.worktree?.path ?? session.cwd
  const entries = await readTranscript(sessionId)
  if (!entries.some((e) => e.kind === 'user')) throw new Error('A sessão ainda não tem conversa para refletir.')
  const trajectory = condenseTrajectory(entries)
  const current = await readTree(dir)
  // The harness as it was when the session started: the latest snapshot taken before it, if any.
  const base = getSnapshots(project).find((s) => s.createdAt <= session.createdAt)
  const source: Lesson['source'] = { kind: 'session', sessionId }
  const input: ReflectInput = {
    projectCwd: project,
    task: trajectory.task,
    baseTree: base?.tree ?? current,
    candidates: [
      {
        label: `session "${session.title}"`,
        tree: current,
        trajectory: trajectory.text,
        changes: await gitChanges(dir),
        costUsd: trajectory.costUsd,
        durationMs: trajectory.durationMs,
        adopted: true
      }
    ],
    source
  }
  const { parsed, raw } = await runReflection(input, opts.model)
  const reflection: Reflection = { id: nanoid(10), projectCwd: project, createdAt: Date.now(), edits: parsed.edits, source }
  putReflection(reflection)
  // One run without a contrast can't support high confidence (the prompt says so too).
  const exp = parsed.experience && {
    ...parsed.experience,
    confidence: parsed.experience.confidence === 'high' ? ('medium' as const) : parsed.experience.confidence
  }
  return {
    reflection,
    lesson: exp ? toLesson(project, exp, source) : undefined,
    baseSnapshot: base ? { id: base.id, label: base.label, createdAt: base.createdAt } : undefined,
    raw
  }
}

function saveLesson(lesson: Lesson, reflectionId?: string): Lesson {
  if (!lesson.cue?.trim() || !lesson.lesson?.trim()) throw new Error('A lição precisa de “quando” e “o quê”.')
  const project = normalizeProject(lesson.projectCwd)
  const saved = putLesson({
    ...lesson,
    id: lesson.id || nanoid(10),
    projectCwd: project,
    cue: lesson.cue.trim(),
    lesson: lesson.lesson.trim(),
    evidence: lesson.evidence?.trim() ?? '',
    createdAt: lesson.createdAt || Date.now()
  })
  if (reflectionId) {
    const r = getReflections(project).find((x) => x.id === reflectionId)
    if (r) putReflection({ ...r, lessonId: saved.id })
  }
  return saved
}

function updateLesson(projectCwd: string, id: string, patch: LessonPatch): Lesson {
  const current = getLessons(projectCwd).find((l) => l.id === id)
  if (!current) throw new Error('Lição não encontrada.')
  const allowed: LessonPatch = {}
  for (const k of ['cue', 'lesson', 'evidence', 'confidence', 'enabled'] as const) {
    if (patch[k] !== undefined) (allowed as Record<string, unknown>)[k] = patch[k]
  }
  return putLesson({ ...current, ...allowed })
}

export const harnessFeature: Feature = {
  name: 'harness',
  register() {
    ipcMain.handle(HARNESS.read, (_e, dir: string) => readHarnessState(dir))
    ipcMain.handle(HARNESS.writeFile, async (_e, dir: string, rel: string, content: string) => {
      await writeHarnessFile(dir, rel, content)
      filesChanged(dir)
    })
    ipcMain.handle(HARNESS.deleteFile, async (_e, dir: string, rel: string) => {
      await deleteHarnessFile(dir, rel)
      filesChanged(dir)
    })
    ipcMain.handle(HARNESS.createFromTemplate, (_e, dir: string, kind: TemplateKind, name?: string) => createFromTemplate(dir, kind, name))
    ipcMain.handle(HARNESS.snapshots, (_e, projectCwd: string) => getSnapshots(projectCwd))
    ipcMain.handle(HARNESS.snapshotCreate, async (_e, projectCwd: string, label: string, dir?: string, note?: string) =>
      createSnapshot(projectCwd, label, 'manual', await readTree(dir ?? projectCwd), note)
    )
    ipcMain.handle(HARNESS.snapshotRestore, (_e, projectCwd: string, id: string, dir?: string) => restoreSnapshot(projectCwd, id, dir))
    ipcMain.handle(HARNESS.snapshotDelete, (_e, projectCwd: string, id: string) => removeSnapshot(projectCwd, id))
    ipcMain.handle(HARNESS.diff, (_e, from: HarnessTree, to: HarnessTree) => diffTrees(from, to))
    ipcMain.handle(HARNESS.lessons, (_e, projectCwd: string) => getLessons(projectCwd))
    ipcMain.handle(HARNESS.saveLesson, (_e, lesson: Lesson, reflectionId?: string) => saveLesson(lesson, reflectionId))
    ipcMain.handle(HARNESS.updateLesson, (_e, projectCwd: string, id: string, patch: LessonPatch) => updateLesson(projectCwd, id, patch))
    ipcMain.handle(HARNESS.deleteLesson, (_e, projectCwd: string, id: string) => removeLesson(projectCwd, id))
    ipcMain.handle(HARNESS.reflections, (_e, projectCwd: string) => getReflections(projectCwd))
    ipcMain.handle(HARNESS.reflectSession, (_e, sessionId: string, opts?: ReflectSessionOptions) => reflectSession(sessionId, opts))

    registerSystemAppend('harness-lessons', sessionLessons)

    // The agent edits harness files too: tell open panels to reload.
    bus.on('session:file-written', ({ sessionId, path }: { sessionId: string; path: string }) => {
      const s = db('sessions').get(sessionId)
      if (!s) return
      const dir = s.worktree?.path ?? s.cwd
      if (isHarnessPath(relative(dir, path))) filesChanged(dir)
    })
    bus.on('session:turn-ended', ({ sessionId }: { sessionId: string }) => {
      const s = db('sessions').get(sessionId)
      if (s) filesChanged(s.worktree?.path ?? s.cwd)
    })
  }
}
