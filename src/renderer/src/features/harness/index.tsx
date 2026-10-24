// Feature "harness" — renderer side. Owned by the harness agent.
import type { Session } from '@shared/contracts'
import type { HarnessTree } from '@shared/harness'

/** Side-panel tab: the project's harness (components, snapshots, lessons). */
export function HarnessPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Harness</div>
}

/** Reusable editor for a harness tree (used by the lab to edit variants). */
export function HarnessTreeEditor(_props: { tree: HarnessTree; onChange: (tree: HarnessTree) => void; readOnly?: boolean }) {
  return null
}
