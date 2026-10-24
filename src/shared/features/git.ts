// IPC channels and payload types for the "git" feature. Owned by the git agent.
export const GIT = {
  isRepo: 'git:isRepo',
  worktreeCreate: 'git:worktreeCreate'
} as const
