// Feature "git" — renderer side. Owned by the git agent.
import type { Session } from '@shared/contracts'

/** Side-panel tab: changed files and their diffs, commit/branch actions. */
export function ChangesPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Changes</div>
}

/** Side-panel tab: file tree and file viewer. */
export function FilesPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Files</div>
}
