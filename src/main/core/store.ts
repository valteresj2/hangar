// JSON-file persistence for the core collections and settings.
// Lives in <userData>/hangar-data/. Writes are debounced and atomic (tmp + rename).
// Every mutation broadcasts `store:event:changed` so renderers can refetch.

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type CollectionName, type Collections, type Settings } from '../../shared/contracts'
import { CORE } from '../../shared/ipc'
import { broadcast } from './broadcast'
import { bus } from './bus'

type Row = { id: string }

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

class Collection<T extends Row> {
  private rows = new Map<string, T>()
  private timer: NodeJS.Timeout | undefined
  private readonly file: string

  constructor(private readonly name: CollectionName) {
    this.file = join(dataDir(), `${name}.json`)
    for (const row of readJson<T[]>(this.file, [])) this.rows.set(row.id, row)
  }

  list(): T[] {
    return [...this.rows.values()]
  }

  get(id: string): T | undefined {
    return this.rows.get(id)
  }

  put(row: T): T {
    this.rows.set(row.id, row)
    this.changed(row.id)
    return row
  }

  patch(id: string, patch: Partial<T>): T | undefined {
    const current = this.rows.get(id)
    if (!current) return undefined
    const next = { ...current, ...patch, id }
    this.rows.set(id, next)
    this.changed(id)
    return next
  }

  delete(id: string): boolean {
    const removed = this.rows.delete(id)
    if (removed) this.changed(id)
    return removed
  }

  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    writeJsonAtomic(this.file, this.list())
  }

  private changed(id: string): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 150)
    broadcast(CORE.storeChanged, { collection: this.name, id })
    bus.emit('store:changed', { collection: this.name, id })
  }
}

class SettingsStore {
  private value: Settings
  private readonly file = join(dataDir(), 'settings.json')

  constructor() {
    this.value = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(this.file, {}) }
  }

  get(): Settings {
    return this.value
  }

  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    writeJsonAtomic(this.file, this.value)
    broadcast(CORE.storeChanged, { collection: 'settings' })
    bus.emit('store:changed', { collection: 'settings' })
    return this.value
  }
}

let collections: { [K in CollectionName]: Collection<Collections[K]> } | undefined
let settingsStore: SettingsStore | undefined

/** Typed access to a collection. Call only after app 'ready'. */
export function db<K extends CollectionName>(name: K): Collection<Collections[K]> {
  collections ??= {
    sessions: new Collection('sessions'),
    projects: new Collection('projects'),
    groups: new Collection('groups')
  }
  return collections[name]
}

export function settings(): SettingsStore {
  settingsStore ??= new SettingsStore()
  return settingsStore
}

export function flushAll(): void {
  if (!collections) return
  for (const c of Object.values(collections)) c.flush()
}
