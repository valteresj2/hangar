import { useEffect } from 'react'
import { ChatView } from './features/engine'
import { NewSessionView, Sidebar } from './features/sessions'
import { CommandPalette, SettingsView } from './features/settings'
import { LabView } from './features/lab'
import { useRow, useSettings } from './core/data'
import { useUi } from './core/ui'
import { SidePanel } from './shell/SidePanel'
import { TopBar } from './shell/TopBar'
import styles from './shell/shell.module.css'

function useThemeAttribute(): void {
  const settings = useSettings()
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const pref = settings?.theme ?? 'system'
      const dark = pref === 'dark' || (pref === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.theme])
}

export function App() {
  useThemeAttribute()
  const { activeSessionId, sidebarOpen, sidePanelOpen, settingsOpen, setSettingsOpen, labCwd, closeLab } = useUi()
  const session = useRow('sessions', activeSessionId)

  if (settingsOpen) return <SettingsView onClose={() => setSettingsOpen(false)} />
  if (labCwd) return <LabView cwd={labCwd} onClose={closeLab} />

  return (
    <div className={styles.app}>
      {sidebarOpen && (
        <aside className={styles.sidebar}>
          <Sidebar />
        </aside>
      )}
      <div className={styles.main}>
        <TopBar session={session} />
        <div className={styles.body}>
          <main className={styles.center}>{session ? <ChatView key={session.id} session={session} /> : <NewSessionView />}</main>
          {session && sidePanelOpen && <SidePanel session={session} />}
        </div>
      </div>
      <CommandPalette />
    </div>
  )
}
