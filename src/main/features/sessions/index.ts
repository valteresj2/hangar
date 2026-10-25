// Feature "sessions" — main process side. Owned by the sessions agent.
// Session/project/group CRUD goes through the generic core store; this module only handles what needs
// main-side work: creation with defaults, deletion (with worktree cleanup), Markdown export and CLI import.

import { app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Session } from '../../../shared/contracts'
import {
  DEFAULT_SESSION_TITLE,
  SESSIONS,
  type CreateSessionInput,
  type DeleteSessionOptions,
  type DeleteSessionResult
} from '../../../shared/features/sessions'
import type { Feature, FeatureContext } from '../../core/feature'
import { db, settings } from '../../core/store'
import { interrupt, readTranscript } from '../engine/api'
import { removeWorktree } from '../git/api'
import { importCliSessions, listCliSessions } from './cli'
import { transcriptToMarkdown } from './markdown'
import { handle } from '../../core/handle'

const RECENT_FOLDERS_MAX = 12

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function rememberFolder(cwd: string): void {
  const { recentFolders } = settings().get()
  const next = [cwd, ...recentFolders.filter((f) => !samePath(f, cwd))].slice(0, RECENT_FOLDERS_MAX)
  settings().patch({ recentFolders: next })
}

export function createSession(input: CreateSessionInput): Session {
  if (!input.cwd) throw new Error('A sessão precisa de uma pasta.')
  const defaults = settings().get()
  const now = Date.now()
  const session: Session = {
    id: input.id ?? nanoid(),
    title: input.title?.trim() || DEFAULT_SESSION_TITLE,
    cwd: input.cwd,
    pinned: false,
    archived: false,
    unread: false,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    model: input.model ?? defaults.defaultModel,
    effort: input.effort ?? defaults.defaultEffort,
    permissionMode: input.permissionMode ?? defaults.defaultPermissionMode
  }
  if (input.projectId) session.projectId = input.projectId
  if (input.groupId) session.groupId = input.groupId
  if (input.worktree) session.worktree = input.worktree
  db('sessions').put(session)
  rememberFolder(input.cwd)
  return session
}

async function deleteSession(id: string, opts: DeleteSessionOptions = {}): Promise<DeleteSessionResult> {
  const session = db('sessions').get(id)
  if (!session) return { deleted: false }
  await interrupt(id).catch((err) => console.warn('[sessions] interrupt before delete failed', err))
  // Deleting the row first makes every feature release what it holds inside the worktree (Claude Code
  // process, terminals, dev servers); on Windows those would otherwise keep the folder locked.
  db('sessions').delete(id)
  let worktreeError: string | undefined
  if (opts.removeWorktree && session.worktree) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await removeWorktree(session.worktree)
        worktreeError = undefined
        break
      } catch (err) {
        worktreeError = err instanceof Error ? err.message : String(err)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
  return { deleted: true, worktreeError }
}

function fileSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // eslint-disable-next-line no-control-regex -- control characters are invalid in Windows file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return slug || 'sessao'
}

async function exportMarkdown(ctx: FeatureContext, id: string): Promise<string | undefined> {
  const session = db('sessions').get(id)
  if (!session) throw new Error('Sessão não encontrada.')
  const markdown = transcriptToMarkdown(session, await readTranscript(id))
  const opts: Electron.SaveDialogOptions = {
    title: 'Exportar como Markdown',
    defaultPath: join(app.getPath('documents'), `${fileSlug(session.title)}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }
  const win = ctx.mainWindow()
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return undefined
  await writeFile(res.filePath, markdown, 'utf8')
  return res.filePath
}

export const sessionsFeature: Feature = {
  name: 'sessions',
  register(ctx) {
    handle(SESSIONS.create, (_e, input: CreateSessionInput) => createSession(input))
    handle(SESSIONS.delete, (_e, id: string, opts?: DeleteSessionOptions) => deleteSession(id, opts))
    handle(SESSIONS.exportMarkdown, (_e, id: string) => exportMarkdown(ctx, id))
    handle(SESSIONS.listCli, () => listCliSessions())
    handle(SESSIONS.importCli, (_e, ids: string[]) => importCliSessions(ids))
  }
}
