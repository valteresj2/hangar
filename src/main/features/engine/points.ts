// Pending rewind points. After a rewind the Claude Code session must be resumed at an earlier message
// (`resumeSessionAt`) until a new message lands there and becomes the latest branch; the point survives restarts.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let points: Record<string, string> | undefined

function file(): string {
  return join(app.getPath('userData'), 'hangar-data', 'engine', 'rewind-points.json')
}

function load(): Record<string, string> {
  if (!points) {
    try {
      points = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>
    } catch {
      points = {}
    }
  }
  return points
}

function save(): void {
  const dir = join(app.getPath('userData'), 'hangar-data', 'engine')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(`${file()}.tmp`, JSON.stringify(load(), null, 2), 'utf8')
  renameSync(`${file()}.tmp`, file())
}

/** Chain UUID the session should resume at, if a rewind is still pending. */
export function rewindPoint(sessionId: string): string | undefined {
  return load()[sessionId]
}

export function setRewindPoint(sessionId: string, uuid: string | undefined): void {
  const all = load()
  if (uuid) all[sessionId] = uuid
  else if (sessionId in all) delete all[sessionId]
  else return
  save()
}
