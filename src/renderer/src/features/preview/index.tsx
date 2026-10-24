// Feature "preview" — renderer side. Owned by the preview agent.
import type { Session } from '@shared/contracts'

/** Side-panel tab: embedded browser with tabs and dev-server preview. */
export function BrowserPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Browser</div>
}

/** Side-panel tab: rendered artifacts (HTML/SVG/Markdown) produced in the session. */
export function ArtifactsPanel(_props: { session: Session }) {
  return <div style={{ padding: 12 }}>Artifacts</div>
}
