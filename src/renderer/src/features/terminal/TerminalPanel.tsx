import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import { useUi } from '../../core/ui'
import {
  NO_TABS,
  attachTerminal,
  closeTab,
  detachTerminal,
  fitTerminal,
  focusTerminal,
  lastShell,
  openTerminal,
  renameTab,
  setActiveTab,
  startTerminals,
  useTerminals,
  type TabMeta
} from './terminals'
import styles from './terminal.module.css'

/** Sessions that already got their automatic first terminal (so closing the last tab doesn't respawn one). */
const autoOpened = new Set<string>()

function Tab({ tab, active, onSelect }: { tab: TabMeta; active: boolean; onSelect(): void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tab.title)

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== tab.title) renameTab(tab.id, draft)
  }

  return (
    <div
      className={`${styles.tab} ${active ? styles.tabActive : ''} ${tab.exitCode !== undefined ? styles.tabExited : ''}`}
      onClick={onSelect}
      onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
      onDoubleClick={() => {
        setDraft(tab.title)
        setEditing(true)
      }}
      title={tab.exitCode !== undefined ? `${tab.title} (encerrado: ${tab.exitCode})` : 'Duplo clique para renomear'}
    >
      {editing ? (
        <input
          className={styles.tabInput}
          value={draft}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className={styles.tabTitle}>{tab.title}</span>
      )}
      <button
        className={styles.tabClose}
        title="Fechar terminal"
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

function ShellMenu({ session, onClose }: { session: Session; onClose(): void }) {
  const shells = useTerminals((s) => s.shells)
  const ref = useRef<HTMLDivElement>(null)
  const current = lastShell() ?? shells[0]?.id

  useEffect(() => {
    const down = (e: PointerEvent) => {
      // The anchor (parent) holds the toggle button too, so clicking it doesn't close-then-reopen.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div ref={ref} className={styles.menu}>
      {shells.length === 0 && <div className={`${styles.menuItem} muted`}>Nenhum shell encontrado</div>}
      {shells.map((shell) => (
        <button
          key={shell.id}
          className={styles.menuItem}
          title={shell.path}
          onClick={() => {
            onClose()
            void openTerminal(session, shell.id)
          }}
        >
          <span>{shell.name}</span>
          {shell.id === current && <span className="muted">padrão</span>}
        </button>
      ))}
    </div>
  )
}

/** Side-panel tab: integrated terminals (multiple tabs) rooted at the session cwd. */
export function TerminalPanel({ session }: { session: Session }) {
  const ids = useTerminals((s) => s.order[session.id] ?? NO_TABS)
  const tabs = useTerminals((s) => s.tabs)
  const activeId = useTerminals((s) => s.active[session.id])
  const synced = useTerminals((s) => s.synced)
  const error = useTerminals((s) => s.error)
  const visible = useUi((s) => s.sidePanelOpen && s.sidePanelTab === 'terminal')
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void startTerminals()
  }, [])

  // First time the panel is shown for a session with no terminals: open one.
  useEffect(() => {
    if (!visible || !synced || autoOpened.has(session.id)) return
    autoOpened.add(session.id)
    if (ids.length === 0) void openTerminal(session)
  }, [visible, synced, session, ids.length])

  // Mount the active terminal's DOM into the container; keep it sized with the panel.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !activeId) return
    attachTerminal(activeId, container)
    // ResizeObserver already fires at most once per frame, so fit directly.
    const observer = new ResizeObserver(() => fitTerminal(activeId))
    observer.observe(container)
    return () => {
      observer.disconnect()
      detachTerminal(activeId)
    }
  }, [activeId])

  // Focus when the panel is opened or the tab changes, but not on a session switch (keeps the chat focused).
  const focusedSession = useRef(session.id)
  useEffect(() => {
    const sameSession = focusedSession.current === session.id
    focusedSession.current = session.id
    if (visible && activeId && sameSession) focusTerminal(activeId)
  }, [visible, activeId, session.id])

  return (
    <div className={styles.panel}>
      <div className={styles.tabBar}>
        <div className={styles.tabs}>
          {ids.map((id) =>
            tabs[id] ? (
              <Tab key={id} tab={tabs[id]} active={id === activeId} onSelect={() => setActiveTab(session.id, id)} />
            ) : null
          )}
        </div>
        <div className={styles.actions}>
          <button className="icon-btn" title="Novo terminal" onClick={() => void openTerminal(session)}>
            +
          </button>
          <div className={styles.menuAnchor}>
            <button className="icon-btn" title="Escolher shell" onClick={() => setMenuOpen((o) => !o)}>
              ▾
            </button>
            {menuOpen && <ShellMenu session={session} onClose={() => setMenuOpen(false)} />}
          </div>
        </div>
      </div>
      {error && (
        <div className={styles.error}>
          <span>{error}</span>
          <button className="icon-btn" title="Dispensar" onClick={() => useTerminals.setState({ error: undefined })}>
            ×
          </button>
        </div>
      )}
      <div className={styles.body}>
        <div ref={containerRef} className={styles.viewport} hidden={!activeId} />
        {!activeId && synced && (
          <div className={styles.empty}>
            <p className="muted">Nenhum terminal aberto.</p>
            <button className="btn btn-primary" onClick={() => void openTerminal(session)}>
              Novo terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
