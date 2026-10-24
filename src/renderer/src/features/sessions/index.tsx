// Feature "sessions" — renderer side. Owned by the sessions agent.
// Public surface used by App / TopBar; implementation lives in the sibling modules.

/** Left sidebar: new session, session list, groups, projects, search. */
export { Sidebar } from './Sidebar'

/** Landing view shown when no session is selected: choose a folder and type the first prompt. */
export { NewSessionView } from './NewSessionView'

/** Session header actions (rename, pin, archive, export). Rendered in the top bar. */
export { SessionHeader } from './SessionHeader'
