import type { Session, SidePanelTab } from '@shared/contracts'
import { SessionHeader } from '../features/sessions'
import { useUi } from '../core/ui'
import styles from './shell.module.css'

const PANEL_BUTTONS: { tab: SidePanelTab; label: string }[] = [
  { tab: 'terminal', label: 'Terminal' },
  { tab: 'changes', label: 'Alterações' },
  { tab: 'files', label: 'Arquivos' },
  { tab: 'browser', label: 'Navegador' },
  { tab: 'artifacts', label: 'Artifacts' }
]

export function TopBar({ session }: { session?: Session }) {
  const { toggleSidebar, sidePanelOpen, sidePanelTab, openSidePanel, closeSidePanel, setSettingsOpen } = useUi()

  return (
    <header className={styles.topbar}>
      <button className="icon-btn" title="Alternar sidebar (Ctrl+B)" onClick={toggleSidebar}>
        ☰
      </button>
      <div className={styles.title}>{session ? session.title : 'Hangar'}</div>
      {session && <SessionHeader session={session} />}
      <div className={styles.spacer} />
      {session &&
        PANEL_BUTTONS.map(({ tab, label }) => {
          const active = sidePanelOpen && sidePanelTab === tab
          return (
            <button
              key={tab}
              className={`${styles.panelBtn} ${active ? styles.panelBtnActive : ''}`}
              onClick={() => (active ? closeSidePanel() : openSidePanel(tab))}
            >
              {label}
            </button>
          )
        })}
      <button className="icon-btn" title="Configurações" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
    </header>
  )
}
