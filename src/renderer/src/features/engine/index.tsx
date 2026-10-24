// Feature "engine" — renderer side (chat). Owned by the engine agent.
import type { Session } from '@shared/contracts'

/** Transcript + composer for one session. */
export function ChatView({ session }: { session: Session }) {
  return <div style={{ padding: 24 }}>Chat: {session.title}</div>
}
