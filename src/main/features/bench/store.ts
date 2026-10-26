// Bench runs on disk: <userData>/hangar-data/bench/<id>.json (results only: no secrets, no transcripts).
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchRun } from '../../../shared/features/bench'

function dir(): string {
  const d = join(app.getPath('userData'), 'hangar-data', 'bench')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function saveRun(run: BenchRun): void {
  const file = join(dir(), `${run.id}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2), 'utf8')
  renameSync(`${file}.tmp`, file)
}

export function loadRun(id: string): BenchRun | undefined {
  if (!/^bench_[a-z0-9_-]+$/i.test(id)) return undefined
  try {
    return JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8')) as BenchRun
  } catch {
    return undefined
  }
}

export function listRuns(): BenchRun[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadRun(f.slice(0, -5)))
    .filter((r): r is BenchRun => !!r)
    .sort((a, b) => b.startedAt - a.startedAt)
}
