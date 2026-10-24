// Main -> renderer events of the settings feature (notification clicks, tray menu).
// Used by both CommandPalette and SettingsView, which are never mounted at the same time.
import { useEffect } from 'react'
import { SETTINGS } from '@shared/features/settings'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'

export function useAppEvents(): void {
  useEffect(() => {
    const offFocus = bridge.on(SETTINGS.focusSession, (payload: { sessionId: string }) => {
      const ui = useUi.getState()
      ui.setSettingsOpen(false)
      ui.setPaletteOpen(false)
      ui.selectSession(payload.sessionId)
    })
    const offNew = bridge.on(SETTINGS.newSession, () => {
      const ui = useUi.getState()
      ui.setSettingsOpen(false)
      ui.setPaletteOpen(false)
      ui.selectSession(undefined)
    })
    return () => {
      offFocus()
      offNew()
    }
  }, [])
}
