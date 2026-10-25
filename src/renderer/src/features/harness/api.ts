// Renderer wrappers and data hooks for the harness feature.
import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { HarnessTree, Lesson } from '@shared/harness'
import {
  HARNESS,
  type HarnessChange,
  type LessonPatch,
  type ReflectProposal,
  type ReflectSessionOptions,
  type TemplateKind
} from '@shared/features/harness'
import { bridge } from '../../core/api'

export const harnessApi = {
  read: (dir: string) => bridge.invoke(HARNESS.read, dir),
  writeFile: (dir: string, rel: string, content: string) => bridge.invoke(HARNESS.writeFile, dir, rel, content),
  deleteFile: (dir: string, rel: string) => bridge.invoke(HARNESS.deleteFile, dir, rel),
  createFromTemplate: (dir: string, kind: TemplateKind, name?: string) =>
    bridge.invoke(HARNESS.createFromTemplate, dir, kind, name),
  snapshots: (project: string) => bridge.invoke(HARNESS.snapshots, project),
  snapshotCreate: (project: string, label: string, dir?: string) =>
    bridge.invoke(HARNESS.snapshotCreate, project, label, dir),
  snapshotRestore: (project: string, id: string, dir?: string) =>
    bridge.invoke(HARNESS.snapshotRestore, project, id, dir),
  snapshotDelete: (project: string, id: string) => bridge.invoke(HARNESS.snapshotDelete, project, id),
  diff: (from: HarnessTree, to: HarnessTree) => bridge.invoke(HARNESS.diff, from, to),
  lessons: (project: string) => bridge.invoke(HARNESS.lessons, project),
  saveLesson: (lesson: Lesson, reflectionId?: string) => bridge.invoke(HARNESS.saveLesson, lesson, reflectionId),
  updateLesson: (project: string, id: string, patch: LessonPatch) =>
    bridge.invoke(HARNESS.updateLesson, project, id, patch),
  deleteLesson: (project: string, id: string) => bridge.invoke(HARNESS.deleteLesson, project, id),
  reflections: (project: string) => bridge.invoke(HARNESS.reflections, project),
  reflectSession: (sessionId: string, opts?: ReflectSessionOptions) =>
    bridge.invoke(HARNESS.reflectSession, sessionId, opts)
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** Loads `fetcher()` and reloads it on matching `harness:event:changed` events. */
function useHarnessData<T>(key: string | undefined, fetcher: () => Promise<T>, matches: (c: HarnessChange) => boolean) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  // fetcher/matches are recreated every render; the key is what identifies the query.
  const fetchRef = useRef(fetcher)
  const matchRef = useRef(matches)
  fetchRef.current = fetcher
  matchRef.current = matches
  useEffect(() => {
    if (!key) return
    let alive = true
    const run = () =>
      void fetchRef
        .current()
        .then((d) => {
          if (!alive) return
          setData(d)
          setError(undefined)
        })
        .catch((err) => alive && setError(errorText(err)))
    run()
    const off = bridge.on(HARNESS.evChanged, (c: HarnessChange) => {
      if (matchRef.current(c)) run()
    })
    return () => {
      alive = false
      off()
    }
  }, [key, tick])
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) }
}

export function useHarnessState(dir: string | undefined) {
  return useHarnessData(
    dir,
    () => harnessApi.read(dir!),
    (c) => c.what === 'files' && samePath(c.dir, dir)
  )
}

export function useSnapshots(project: string | undefined) {
  return useHarnessData(
    project,
    () => harnessApi.snapshots(project!),
    (c) => c.what === 'snapshots' && samePath(c.projectCwd, project)
  )
}

export function useLessons(project: string | undefined) {
  return useHarnessData(
    project,
    () => harnessApi.lessons(project!),
    (c) => c.what === 'lessons' && samePath(c.projectCwd, project)
  )
}

/** In-flight and finished session reflections, kept across tab switches (not persisted). */
interface ReflectState {
  bySession: Record<string, { running: boolean; proposal?: ReflectProposal; error?: string; savedLessonId?: string }>
  start(sessionId: string, opts?: ReflectSessionOptions): Promise<void>
  discard(sessionId: string): void
  markSaved(sessionId: string, lessonId: string): void
}

export const useReflect = create<ReflectState>((set, get) => ({
  bySession: {},
  start: async (sessionId, opts) => {
    if (get().bySession[sessionId]?.running) return
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { running: true } } }))
    try {
      const proposal = await harnessApi.reflectSession(sessionId, opts)
      set((s) => ({ bySession: { ...s.bySession, [sessionId]: { running: false, proposal } } }))
    } catch (err) {
      set((s) => ({ bySession: { ...s.bySession, [sessionId]: { running: false, error: errorText(err) } } }))
    }
  },
  discard: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
  markSaved: (sessionId, lessonId) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: { ...s.bySession[sessionId], running: false, savedLessonId: lessonId } }
    }))
}))

export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
