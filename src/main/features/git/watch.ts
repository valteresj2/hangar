// Change notifications: recursive fs.watch on folders the renderer is looking at, plus engine
// bus events. Everything funnels into a debounced `git:event:changed` broadcast per folder.
import { watch, type FSWatcher } from 'node:fs'
import { GIT, type GitChangedEvent } from '../../../shared/features/git'
import { broadcast } from '../../core/broadcast'

const DEBOUNCE_MS = 350

interface Watched {
  cwd: string
  watcher?: FSWatcher
  refs: number
}

const watched = new Map<string, Watched>()
const timers = new Map<string, NodeJS.Timeout>()

const keyOf = (cwd: string) =>
  cwd
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()

/** Debounced `git:event:changed` for `cwd`. */
export function notifyChanged(cwd: string): void {
  const key = keyOf(cwd)
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      broadcast(GIT.changed, { cwd } satisfies GitChangedEvent)
    }, DEBOUNCE_MS)
  )
}

/** Inside .git only index/HEAD/refs matter (stage, commit, checkout); objects and locks are noise. */
function relevant(file: string | null): boolean {
  if (!file) return true
  const p = file.replace(/\\/g, '/')
  if (p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/')) return false
  if (p === '.git' || p.startsWith('.git/')) {
    if (p.endsWith('.lock')) return false
    return p === '.git/index' || p === '.git/HEAD' || p.startsWith('.git/refs/')
  }
  return true
}

export function startWatching(cwd: string): void {
  const key = keyOf(cwd)
  const entry = watched.get(key)
  if (entry) {
    entry.refs++
    return
  }
  const next: Watched = { cwd, refs: 1 }
  try {
    next.watcher = watch(cwd, { recursive: true }, (_event, file) => {
      if (relevant(typeof file === 'string' ? file : null)) notifyChanged(cwd)
    })
    next.watcher.on('error', () => {
      next.watcher?.close()
      next.watcher = undefined
    })
  } catch {
    // Missing folder or unsupported platform: bus events still trigger refreshes.
  }
  watched.set(key, next)
}

export function stopWatching(cwd: string): void {
  const key = keyOf(cwd)
  const entry = watched.get(key)
  if (!entry || --entry.refs > 0) return
  entry.watcher?.close()
  watched.delete(key)
}

export function stopAll(): void {
  for (const w of watched.values()) w.watcher?.close()
  watched.clear()
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}
