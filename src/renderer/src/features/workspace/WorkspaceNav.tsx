// The "Agent Hangar" section of the sidebar (above the sessions, collapsible): Início and Meus agentes open native
// screens; Decisões and Caixa de entrada show live badges and open the portal until they move to the app (M2).
// Without a login it offers "Conecte à plataforma".
import { useState } from 'react'
import { useUi } from '../../core/ui'
import { usePlatform } from '../platform'
import { openPortal, useWorkspace } from './api'
import { badge } from './format'
import styles from './workspace.module.css'

const COLLAPSED_KEY = 'hangar.workspace.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0')
  } catch {
    // Storage unavailable: the section just opens expanded next time.
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function NavItem(props: {
  label: string
  active?: boolean
  count?: number
  external?: boolean
  title?: string
  onClick: () => void
}) {
  const text = badge(props.count)
  return (
    <button
      className={`${styles.navItem} ${props.active ? styles.navItemActive : ''}`}
      onClick={props.onClick}
      title={props.title}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className={styles.navLabel}>{props.label}</span>
      {text && (
        <span className={styles.navBadge} aria-label={`${props.count} pendente(s)`} data-badge={props.label}>
          {text}
        </span>
      )}
      {props.external && (
        <span className={styles.navExternal} aria-hidden="true">
          ↗
        </span>
      )}
    </button>
  )
}

const LIVE_TITLE = {
  off: '',
  connecting: 'Conectando aos eventos da plataforma…',
  live: 'Ao vivo: os contadores mudam assim que algo acontece na plataforma.',
  polling: 'Sem eventos ao vivo: atualizando a cada 60 s.'
} as const

export function WorkspaceNav() {
  const state = useWorkspace()
  const platform = usePlatform()
  const view = useUi((s) => s.workspaceView)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  if (!state?.enabled || !platform || platform.status === 'off') return null

  const toggle = () => {
    writeCollapsed(!collapsed)
    setCollapsed(!collapsed)
  }
  const ui = useUi.getState()

  return (
    <section className={styles.nav} aria-label="Agent Hangar">
      <div
        className={styles.navHeader}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <Chevron open={!collapsed} />
        <span className={styles.navTitle}>Agent Hangar</span>
        {state.connected && state.live !== 'off' && (
          <span
            className={`${styles.liveDot} ${state.live === 'live' ? styles.liveOn : ''}`}
            title={LIVE_TITLE[state.live]}
            aria-label={LIVE_TITLE[state.live]}
          />
        )}
        {collapsed && !!(state.badges.decisions || state.badges.inbox) && (
          <span className={styles.navBadge}>{badge((state.badges.decisions ?? 0) + (state.badges.inbox ?? 0))}</span>
        )}
      </div>
      {!collapsed &&
        (state.connected ? (
          <div className={styles.navBody}>
            <NavItem label="Início" active={view === 'home'} onClick={() => ui.openWorkspace('home')} />
            <NavItem label="Meus agentes" active={view === 'agents'} onClick={() => ui.openWorkspace('agents')} />
            <NavItem
              label="Decisões"
              count={state.badges.decisions}
              external
              title="Abrir as decisões no portal (navegador)"
              onClick={() => openPortal({ screen: 'decisions' })}
            />
            <NavItem
              label="Caixa de entrada"
              count={state.badges.inbox}
              external
              title="Abrir a caixa de entrada no portal (navegador)"
              onClick={() => openPortal({ screen: 'inbox' })}
            />
          </div>
        ) : (
          <div className={styles.navBody}>
            <button className={styles.navConnect} onClick={() => ui.openSettings('platform')}>
              {platform.status === 'connecting' ? 'Conectando…' : 'Conecte à plataforma'}
            </button>
            <div className={styles.navHint}>Seus agentes, decisões e a caixa de entrada aparecem aqui.</div>
          </div>
        ))}
    </section>
  )
}
