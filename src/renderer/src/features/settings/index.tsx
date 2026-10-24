// Feature "settings" — renderer side. Owned by the settings agent.
// SettingsView: full-screen settings (General, MCP, Skills, Scheduled, Shortcuts, About).
// CommandPalette: Ctrl+K palette plus the window shortcuts Ctrl+, and Ctrl+`.

export { SettingsView } from './SettingsView'
export { CommandPalette } from './CommandPalette'

/** Root view of the Quick Entry window (loaded with `#quick-entry`). Owned by the settings agent. */
export function QuickEntry() {
  return null
}
