// Feature "sessions" — renderer side. Owned by the sessions agent.
import type { Session } from '@shared/contracts'

/** Left sidebar: new session, session list, groups, projects, search. */
export function Sidebar() {
  return <div style={{ padding: 12, color: 'var(--text-muted)' }}>Sidebar (sessions)</div>
}

/** Landing view shown when no session is selected: choose a folder and type the first prompt. */
export function NewSessionView() {
  return <div style={{ padding: 24 }}>Nova sessão</div>
}

/** Session header actions (rename, pin, archive, export). Rendered in the top bar. */
export function SessionHeader(_props: { session: Session }) {
  return null
}
