// Feature "terminal" — renderer side. Owned by the terminal agent.
import type { Session } from '@shared/contracts'

/** Side-panel tab: integrated terminals (multiple tabs) rooted at the session cwd. */
export function TerminalPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Terminal</div>
}
