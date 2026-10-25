// Typed wrappers over the git:* / files:* channels plus small shared hooks.
import { useEffect, useRef } from 'react'
import type { Session } from '@shared/contracts'
import { FILES, GIT, samePath, type GitChangedEvent, type GitDiffRequest } from '@shared/features/git'
import { bridge } from '../../core/api'

export const gitApi = {
  status: (cwd: string) => bridge.invoke(GIT.status, cwd),
  diff: (cwd: string, req: GitDiffRequest) => bridge.invoke(GIT.diff, cwd, req),
  stage: (cwd: string, paths?: string[]) => bridge.invoke(GIT.stage, cwd, paths),
  unstage: (cwd: string, paths?: string[]) => bridge.invoke(GIT.unstage, cwd, paths),
  discard: (cwd: string, paths: string[], untracked?: boolean) => bridge.invoke(GIT.discard, cwd, paths, untracked),
  commit: (cwd: string, message: string) => bridge.invoke(GIT.commit, cwd, message),
  branches: (cwd: string) => bridge.invoke(GIT.branches, cwd),
  checkout: (cwd: string, branch: string) => bridge.invoke(GIT.checkout, cwd, branch),
  createBranch: (cwd: string, name: string) => bridge.invoke(GIT.createBranch, cwd, name),
  push: (cwd: string) => bridge.invoke(GIT.push, cwd),
  log: (cwd: string, count?: number) => bridge.invoke(GIT.log, cwd, count),
  prStatus: (cwd: string) => bridge.invoke(GIT.prStatus, cwd),
  listDir: (dir: string) => bridge.invoke(FILES.list, dir),
  find: (root: string, query: string) => bridge.invoke(FILES.find, root, query),
  read: (path: string) => bridge.invoke(FILES.read, path),
  openInEditor: (path: string, line?: number) => bridge.invoke(FILES.openInEditor, path, line)
}

export function sessionDir(session: Session): string {
  return session.worktree?.path ?? session.cwd
}

/** Strips Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

/** Watches `cwd` while mounted and calls `onChange` whenever main reports activity there. */
export function useGitChanged(cwd: string, onChange: () => void): void {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    void bridge.invoke(GIT.watch, cwd)
    const off = bridge.on(GIT.changed, (ev: GitChangedEvent) => {
      if (samePath(ev.cwd, cwd)) cb.current()
    })
    return () => {
      off()
      void bridge.invoke(GIT.unwatch, cwd)
    }
  }, [cwd])
}

export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
}
