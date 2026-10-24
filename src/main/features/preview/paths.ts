import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../../core/store'

/** Working directory of a session: its worktree when it has one, else its cwd. */
export function sessionDir(sessionId: string): string {
  const session = db('sessions').get(sessionId)
  if (!session) throw new Error(`Sessão não encontrada: ${sessionId}`)
  return session.worktree?.path ?? session.cwd
}

/** <userData>/hangar-data/preview, created on demand. */
export function previewDataDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'preview')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
