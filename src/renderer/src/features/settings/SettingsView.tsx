import { useEffect, useRef, type ReactNode } from 'react'
import { create } from 'zustand'
import { CommandPalette } from './CommandPalette'
import { useUi } from '../../core/ui'
import { GeneralSection } from './sections/General'
import { McpSection } from './sections/Mcp'
import { ProvidersSection } from './sections/Providers'
import { AboutSection, ShortcutsSection } from './sections/Misc'
import { SchedulesSection } from './sections/Schedules'
import { SkillsSection } from './sections/Skills'
import { PlatformSection } from '../platform'
import styles from './settings.module.css'

export type SettingsSectionId =
  'general' | 'providers' | 'platform' | 'mcp' | 'skills' | 'schedules' | 'shortcuts' | 'about'

const SECTIONS: { id: SettingsSectionId; label: string; render: () => ReactNode }[] = [
  { id: 'general', label: 'Geral', render: () => <GeneralSection /> },
  { id: 'providers', label: 'Provedores', render: () => <ProvidersSection /> },
  { id: 'platform', label: 'Plataforma', render: () => <PlatformSection /> },
  { id: 'mcp', label: 'Servidores MCP', render: () => <McpSection /> },
  { id: 'skills', label: 'Skills e plugins', render: () => <SkillsSection /> },
  { id: 'schedules', label: 'Tarefas agendadas', render: () => <SchedulesSection /> },
  { id: 'shortcuts', label: 'Atalhos', render: () => <ShortcutsSection /> },
  { id: 'about', label: 'Sobre', render: () => <AboutSection /> }
]

/** Last opened section, kept across open/close (not persisted). */
export const useSettingsSection = create<{ section: SettingsSectionId; setSection(s: SettingsSectionId): void }>(
  (set) => ({
    section: 'general',
    setSection: (section) => set({ section })
  })
)

export function SettingsView({ onClose }: { onClose: () => void }) {
  const { section, setSection } = useSettingsSection()
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const contentRef = useRef<HTMLDivElement>(null)

  // Deep link from elsewhere in the app (useUi().openSettings('providers')).
  const requested = useUi((s) => s.settingsSection)
  useEffect(() => {
    if (!requested) return
    const match = SECTIONS.find((s) => s.id === requested)
    if (match) setSection(match.id)
    useUi.setState({ settingsSection: undefined })
  }, [requested, setSection])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    // Chromium's scrollTo returns a promise; keep it out of the effect's return value.
    void contentRef.current?.scrollTo({ top: 0 })
  }, [section])

  return (
    <div className={styles.root}>
      <nav className={styles.nav}>
        <div className={styles.navTitle}>
          <button className="icon-btn" title="Voltar (Esc)" onClick={onClose}>
            ←
          </button>
          Configurações
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`${styles.navItem} ${s.id === current.id ? styles.navItemActive : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className={`${styles.navFooter} muted`}>Esc para fechar</div>
      </nav>
      <div className={styles.content} ref={contentRef}>
        <div className={styles.contentInner}>
          <header className={styles.header}>
            <h1>{current.label}</h1>
            <button className="icon-btn" title="Fechar (Esc)" onClick={onClose}>
              ✕
            </button>
          </header>
          {current.render()}
        </div>
      </div>
      {/* App unmounts its palette while settings are open; keep Ctrl+K and app events working here. */}
      <CommandPalette />
    </div>
  )
}
