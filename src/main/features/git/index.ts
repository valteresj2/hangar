// Feature "git" — main process side. Owned by the git agent.
import { ipcMain, type WebContents } from 'electron'
import type { Worktree } from '../../../shared/contracts'
import { FILES, GIT, type GitDiffRequest } from '../../../shared/features/git'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { db } from '../../core/store'
import { createWorktree, isGitRepo, removeWorktree } from './api'
import { findFiles, listDir, openInEditor, readFileContent } from './files'
import * as ops from './ops'
import { notifyChanged, startWatching, stopAll, stopWatching } from './watch'

/** Folders each renderer asked to watch, so they are released when it goes away. */
const watchesBySender = new Map<number, string[]>()

function trackWatch(sender: WebContents, cwd: string): void {
  let list = watchesBySender.get(sender.id)
  if (!list) {
    list = []
    watchesBySender.set(sender.id, list)
    const id = sender.id
    sender.once('destroyed', () => {
      for (const dir of watchesBySender.get(id) ?? []) stopWatching(dir)
      watchesBySender.delete(id)
    })
  }
  list.push(cwd)
  startWatching(cwd)
}

function untrackWatch(sender: WebContents, cwd: string): void {
  const list = watchesBySender.get(sender.id)
  const i = list?.indexOf(cwd) ?? -1
  if (list && i >= 0) {
    list.splice(i, 1)
    stopWatching(cwd)
  }
}

function sessionDir(sessionId: string): string | undefined {
  const s = db('sessions').get(sessionId)
  return s ? (s.worktree?.path ?? s.cwd) : undefined
}

/** Runs a mutating operation and tells every window to refresh `cwd`. */
async function mutate<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    notifyChanged(cwd)
  }
}

export const gitFeature: Feature = {
  name: 'git',
  register() {
    ipcMain.handle(GIT.isRepo, (_e, cwd: string) => isGitRepo(cwd))
    ipcMain.handle(GIT.worktreeCreate, (_e, cwd: string, branch?: string) => createWorktree(cwd, branch))
    ipcMain.handle(GIT.worktreeRemove, (_e, wt: Worktree) => removeWorktree(wt))

    ipcMain.handle(GIT.status, (_e, cwd: string) => ops.status(cwd))
    ipcMain.handle(GIT.diff, (_e, cwd: string, req: GitDiffRequest) => ops.diff(cwd, req))
    ipcMain.handle(GIT.stage, (_e, cwd: string, paths?: string[]) => mutate(cwd, () => ops.stage(cwd, paths)))
    ipcMain.handle(GIT.unstage, (_e, cwd: string, paths?: string[]) => mutate(cwd, () => ops.unstage(cwd, paths)))
    ipcMain.handle(GIT.discard, (_e, cwd: string, paths: string[], untracked?: boolean) =>
      mutate(cwd, () => ops.discard(cwd, paths, untracked))
    )
    ipcMain.handle(GIT.commit, (_e, cwd: string, message: string) => mutate(cwd, () => ops.commit(cwd, message)))
    ipcMain.handle(GIT.branches, (_e, cwd: string) => ops.branches(cwd))
    ipcMain.handle(GIT.checkout, (_e, cwd: string, branch: string) => mutate(cwd, () => ops.checkout(cwd, branch)))
    ipcMain.handle(GIT.createBranch, (_e, cwd: string, name: string) => mutate(cwd, () => ops.createBranch(cwd, name)))
    ipcMain.handle(GIT.push, (_e, cwd: string) => mutate(cwd, () => ops.push(cwd)))
    ipcMain.handle(GIT.log, (_e, cwd: string, count?: number) => ops.log(cwd, count))
    ipcMain.handle(GIT.prStatus, (_e, cwd: string) => ops.prStatus(cwd))
    ipcMain.handle(GIT.watch, (e, cwd: string) => trackWatch(e.sender, cwd))
    ipcMain.handle(GIT.unwatch, (e, cwd: string) => untrackWatch(e.sender, cwd))

    ipcMain.handle(FILES.list, (_e, dir: string) => listDir(dir))
    ipcMain.handle(FILES.find, (_e, root: string, query: string) => findFiles(root, query))
    ipcMain.handle(FILES.read, (_e, path: string) => readFileContent(path))
    ipcMain.handle(FILES.openInEditor, (_e, path: string, line?: number) => openInEditor(path, line))

    // The agent finished a turn or wrote a file: refresh that session's folder even if unwatched.
    bus.on('session:turn-ended', ({ sessionId }: { sessionId: string }) => {
      const dir = sessionDir(sessionId)
      if (dir) notifyChanged(dir)
    })
    bus.on('session:file-written', ({ sessionId }: { sessionId: string }) => {
      const dir = sessionDir(sessionId)
      if (dir) notifyChanged(dir)
    })
  },
  dispose() {
    stopAll()
  }
}
