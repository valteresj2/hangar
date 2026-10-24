// Feature "settings" — renderer side. Owned by the settings agent.

/** Full-screen settings view (General, Models, MCP, Skills, Scheduled, Shortcuts). */
export function SettingsView({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ padding: 24 }}>
      Settings <button onClick={onClose}>Fechar</button>
    </div>
  )
}

/** Ctrl+K command palette, mounted once at the app root. */
export function CommandPalette() {
  return null
}
