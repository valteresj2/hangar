// Main-side API of the git feature, used by other features. Owned by the git agent.
import type { Worktree } from '../../../shared/contracts'

export async function createWorktree(_cwd: string, _branch?: string): Promise<Worktree> {
  throw new Error('git.createWorktree not implemented yet')
}

export async function removeWorktree(_wt: Worktree): Promise<void> {}

export async function isGitRepo(_cwd: string): Promise<boolean> {
  return false
}
