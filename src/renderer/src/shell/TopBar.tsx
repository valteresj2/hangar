import type { Session, SidePanelTab } from '@shared/contracts'
import { SessionHeader } from '../features/sessions'
import { useUi } from '../core/ui'
import { GearIcon, SidebarIcon } from './icons'
import styles from './shell.module.css'

const PANEL_BUTTONS: { tab: SidePanelTab; label: string }[] = [
  { tab: 'terminal', label: 'Terminal' },
  { tab: 'changes', label: 'Alterações' },
  { tab: 'files', label: 'Arquivos' },
  { tab: 'browser', label: 'Navegador' },
  { tab: 'artifacts', label: 'Artifacts' },
  { tab: 'harness', label: 'Harness' }
]

export function TopBar({ session }: { session?: Session }) {
  const { toggleSidebar, sidePanelOpen, sidePanelTab, openSidePanel, closeSidePanel, setSettingsOpen } = useUi()

  return (
    <header className={styles.topbar}>
      <button
        className="icon-btn"
        title="Alternar sidebar (Ctrl+B)"
        aria-label="Alternar sidebar"
        onClick={toggleSidebar}
      >
        <SidebarIcon />
      </button>
      {session ? (
        <div className={styles.title}>{session.title}</div>
      ) : (
        // The brand is in the title bar (shell/Brand.tsx); here, what this screen is.
        <div className={styles.title}>Nova sessão</div>
      )}
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
      <button
        className="icon-btn"
        title="Configurações"
        aria-label="Configurações"
        onClick={() => setSettingsOpen(true)}
      >
        <GearIcon />
      </button>
    </header>
  )
}
