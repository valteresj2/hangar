import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session, SidePanelTab } from '@shared/contracts'
import { OPEN_IMPORT_EVENT } from '@shared/features/sessions'
import { api } from '../../core/api'
import { useCollection } from '../../core/data'
import { useUi } from '../../core/ui'
import { shortcutRecorder } from './accelerator'
import { fuzzyScore } from './fuzzy'
import { useAppEvents } from './useAppEvents'
import styles from './palette.module.css'

interface PaletteItem {
  id: string
  group: 'Ações' | 'Sessões'
  label: string
  hint?: string
  keys?: string
  icon: string
  run(): void
}

const PANEL_TABS: { tab: SidePanelTab; label: string; icon: string }[] = [
  { tab: 'terminal', label: 'Terminal', icon: '>' },
  { tab: 'changes', label: 'Changes', icon: '±' },
  { tab: 'files', label: 'Files', icon: '▤' },
  { tab: 'browser', label: 'Browser', icon: '◎' },
  { tab: 'artifacts', label: 'Artifacts', icon: '◇' }
]

const ui = () => useUi.getState()

async function toggleTheme(): Promise<void> {
  const dark = document.documentElement.dataset.theme === 'dark'
  await api.patchSettings({ theme: dark ? 'light' : 'dark' })
}

function openPanel(tab: SidePanelTab): void {
  ui().setSettingsOpen(false)
  ui().openSidePanel(tab)
}

const ACTIONS: PaletteItem[] = [
  {
    id: 'new-session',
    group: 'Ações',
    label: 'Nova sessão',
    keys: 'Ctrl+N',
    icon: '+',
    run: () => {
      ui().setSettingsOpen(false)
      ui().selectSession(undefined)
    }
  },
  { id: 'settings', group: 'Ações', label: 'Abrir configurações', keys: 'Ctrl+,', icon: '⚙', run: () => ui().setSettingsOpen(true) },
  {
    id: 'sidebar',
    group: 'Ações',
    label: 'Alternar sidebar',
    keys: 'Ctrl+B',
    icon: '☰',
    run: () => {
      ui().setSettingsOpen(false)
      ui().toggleSidebar()
    }
  },
  ...PANEL_TABS.map(
    ({ tab, label, icon }): PaletteItem => ({
      id: `panel-${tab}`,
      group: 'Ações',
      label: `Abrir painel: ${label}`,
      keys: tab === 'terminal' ? 'Ctrl+`' : undefined,
      icon,
      run: () => openPanel(tab)
    })
  ),
  { id: 'theme', group: 'Ações', label: 'Alternar tema (claro/escuro)', icon: '◐', run: () => void toggleTheme() },
  {
    id: 'import',
    group: 'Ações',
    label: 'Importar sessões do Claude Code',
    icon: '⇣',
    run: () => {
      ui().setSettingsOpen(false)
      if (!ui().sidebarOpen) ui().toggleSidebar()
      // Let the sessions UI mount before asking it to open its dialog.
      setTimeout(() => window.dispatchEvent(new Event(OPEN_IMPORT_EVENT)), 50)
    }
  }
]

function sessionItem(s: Session): PaletteItem {
  return {
    id: `session-${s.id}`,
    group: 'Sessões',
    label: s.title,
    hint: s.archived ? `arquivada · ${s.cwd}` : s.cwd,
    icon: s.status === 'working' ? '●' : s.status === 'waiting' ? '!' : '○',
    run: () => {
      ui().setSettingsOpen(false)
      ui().selectSession(s.id)
    }
  }
}

/** Window shortcuts owned by settings: Ctrl+K, Ctrl+, and Ctrl+`. Capture phase so xterm etc. don't swallow them. */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutRecorder.active || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui().setPaletteOpen(!ui().paletteOpen)
      } else if (e.key === ',' || e.code === 'Comma') {
        e.preventDefault()
        ui().setPaletteOpen(false)
        ui().setSettingsOpen(true)
      } else if (e.code === 'Backquote' || e.key === '`') {
        e.preventDefault()
        ui().setPaletteOpen(false)
        if (ui().activeSessionId) openPanel('terminal')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function Palette() {
  const sessions = useCollection('sessions')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => ui().setPaletteOpen(false)

  const items = useMemo(() => {
    const sessionItems = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(sessionItem)
    if (!query.trim()) {
      return [...ACTIONS, ...sessionItems.filter((i) => !i.hint?.startsWith('arquivada')).slice(0, 15)]
    }
    return [...ACTIONS, ...sessionItems]
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.group === 'Sessões' ? (item.hint ?? '') : ''}`) }))
      .filter((r): r is { item: PaletteItem; score: number } => r.score !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((r) => r.item)
  }, [sessions, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(items[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // Keep group headers in the order items appear (search results interleave groups by score).
  let lastGroup: string | undefined
  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown} role="dialog" aria-label="Paleta de comandos">
        <input
          className={styles.search}
          autoFocus
          placeholder="Buscar sessões e ações…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.list} ref={listRef} role="listbox">
          {items.length === 0 && <div className={styles.empty}>Nada encontrado.</div>}
          {items.map((item, i) => {
            const header = !query.trim() && item.group !== lastGroup ? item.group : undefined
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className={styles.group}>{header}</div>}
                <button
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  className={`${styles.item} ${i === index ? styles.active : ''}`}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={() => execute(item)}
                >
                  <span className={styles.icon}>{item.icon}</span>
                  <span className={styles.label}>{item.label}</span>
                  {item.hint && <span className={styles.hint}>{item.hint}</span>}
                  {query.trim() && <span className={styles.hint}>{item.group === 'Sessões' ? 'sessão' : 'ação'}</span>}
                  {item.keys && <span className={styles.kbd}>{item.keys}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className={styles.footer}>
          <span>↑↓ navegar</span>
          <span>Enter executar</span>
          <span>Esc fechar</span>
        </div>
      </div>
    </div>
  )
}

/** Ctrl+K command palette, mounted once at the app root (and inside the settings view). */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  useGlobalShortcuts()
  useAppEvents()
  return open ? <Palette /> : null
}
