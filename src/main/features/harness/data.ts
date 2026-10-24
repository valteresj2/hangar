// Per-project persistence: <userData>/hangar-data/harness/<project key>/{snapshots,lessons,reflections}.json.
// Everything is cached in memory after the first (synchronous) load, so the system-prompt provider
// can read lessons without awaiting. Writes are atomic (tmp + rename).

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { HarnessSnapshot, Lesson, Reflection } from '../../../shared/harness'
import { HARNESS, type HarnessChange } from '../../../shared/features/harness'
import { broadcast } from '../../core/broadcast'

/** Snapshots kept per project; the oldest automatic ones go first. */
const MAX_SNAPSHOTS = 200

/** Absolute path without trailing separators (case preserved). */
export function normalizeProject(cwd: string): string {
  const abs = resolve(cwd)
  return abs.length > 3 ? abs.replace(/[\\/]+$/, '') : abs
}

function projectKey(projectCwd: string): string {
  const norm = normalizeProject(projectCwd)
  const keyed = process.platform === 'win32' ? norm.toLowerCase() : norm
  return createHash('sha1').update(keyed).digest('hex').slice(0, 16)
}

function projectDir(projectCwd: string): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'harness', projectKey(projectCwd))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ cwd: normalizeProject(projectCwd) }, null, 2), 'utf8')
  }
  return dir
}

export function scratchDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'harness', '_scratch')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

type FileName = 'snapshots' | 'lessons' | 'reflections'
interface ProjectData {
  snapshots: HarnessSnapshot[]
  lessons: Lesson[]
  reflections: Reflection[]
}

const cache = new Map<string, ProjectData>()

function readList<T>(file: string): T[] {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function load(projectCwd: string): ProjectData {
  const key = projectKey(projectCwd)
  let data = cache.get(key)
  if (!data) {
    const dir = projectDir(projectCwd)
    data = {
      snapshots: readList(join(dir, 'snapshots.json')),
      lessons: readList(join(dir, 'lessons.json')),
      reflections: readList(join(dir, 'reflections.json'))
    }
    cache.set(key, data)
  }
  return data
}

function save(projectCwd: string, name: FileName): void {
  const data = load(projectCwd)
  const file = join(projectDir(projectCwd), `${name}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data[name], null, 2), 'utf8')
  renameSync(tmp, file)
  const change: HarnessChange = { projectCwd: normalizeProject(projectCwd), what: name }
  broadcast(HARNESS.evChanged, change)
}

const newestFirst = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt

// ---- Snapshots ----

export function getSnapshots(projectCwd: string): HarnessSnapshot[] {
  return [...load(projectCwd).snapshots].sort(newestFirst)
}

export function getSnapshot(projectCwd: string, id: string): HarnessSnapshot | undefined {
  return load(projectCwd).snapshots.find((s) => s.id === id)
}

export function putSnapshot(snapshot: HarnessSnapshot): void {
  const data = load(snapshot.projectCwd)
  data.snapshots.push(snapshot)
  if (data.snapshots.length > MAX_SNAPSHOTS) {
    const victim = [...data.snapshots].sort((a, b) => a.createdAt - b.createdAt).find((s) => s.source !== 'manual')
    data.snapshots = data.snapshots.filter((s) => s !== (victim ?? data.snapshots[0]))
  }
  save(snapshot.projectCwd, 'snapshots')
}

export function removeSnapshot(projectCwd: string, id: string): void {
  const data = load(projectCwd)
  data.snapshots = data.snapshots.filter((s) => s.id !== id)
  save(projectCwd, 'snapshots')
}

// ---- Lessons ----

export function getLessons(projectCwd: string): Lesson[] {
  return [...load(projectCwd).lessons].sort(newestFirst)
}

export function putLesson(lesson: Lesson): Lesson {
  const data = load(lesson.projectCwd)
  data.lessons = [...data.lessons.filter((l) => l.id !== lesson.id), lesson]
  save(lesson.projectCwd, 'lessons')
  return lesson
}

export function removeLesson(projectCwd: string, id: string): void {
  const data = load(projectCwd)
  data.lessons = data.lessons.filter((l) => l.id !== id)
  save(projectCwd, 'lessons')
}

// ---- Reflections ----

export function getReflections(projectCwd: string): Reflection[] {
  return [...load(projectCwd).reflections].sort(newestFirst)
}

export function putReflection(reflection: Reflection): Reflection {
  const data = load(reflection.projectCwd)
  data.reflections = [...data.reflections.filter((r) => r.id !== reflection.id), reflection]
  save(reflection.projectCwd, 'reflections')
  return reflection
}
