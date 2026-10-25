// Left sidebar: new session, search, session list (pinned / groups / recent / archived), projects footer.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Group, Project, Session } from '@shared/contracts'
import { ENGINE, type SearchHit } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { useCollection } from '../../core/data'
import { useUi } from '../../core/ui'
import {
  moveToGroup,
  openSession,
  renameSession,
  reorderGroup,
  sessionMenu,
  setArchived,
  setGroupCollapsed,
  setPinned
} from './actions'
import { anchorBelow, ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { ChevronIcon, FolderIcon, ImportIcon, MoreIcon, PlusIcon, SearchIcon } from './icons'
import { setVisibleOrder, useSessionShortcuts } from './shortcuts'
import { RenameInput, StatusDot } from './parts'
import { useSessionsUi } from './store'
import { byUpdatedDesc, relativeTime, sessionDir, shortFolder } from './util'
import styles from './sessions.module.css'

const DND_SESSION = 'application/x-hangar-session'
const DND_GROUP = 'application/x-hangar-group'
const SEARCH_DEBOUNCE_MS = 300

type DropTarget = { kind: 'group'; groupId: string } | { kind: 'recent' } | { kind: 'pinned' } | { kind: 'archived' }

async function dropSession(session: Session, target: DropTarget): Promise<void> {
  switch (target.kind) {
    case 'pinned':
      if (session.archived) await setArchived(session, false)
      if (!session.pinned) await setPinned(session, true)
      return
    case 'archived':
      if (!session.archived) await setArchived(session, true)
      return
    case 'recent':
    case 'group': {
      const groupId = target.kind === 'group' ? target.groupId : undefined
      if (session.archived) await setArchived(session, false)
      if (session.pinned) await setPinned(session, false)
      if (session.groupId !== groupId) await moveToGroup(session.id, groupId)
    }
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

type MenuState = { items: MenuItem[]; at: MenuAnchor } | undefined

function SessionItem(props: {
  session: Session
  active: boolean
  now: number
  snippet?: string
  onMenu: (session: Session, at: MenuAnchor) => void
}) {
  const { session, active, now, snippet, onMenu } = props
  const renaming = useSessionsUi((s) => s.renaming)
  const stopRename = useSessionsUi((s) => s.stopRename)
  const isRenaming = renaming?.id === session.id && renaming.where === 'sidebar'
  const dir = sessionDir(session)

  return (
    <div
      className={`${styles.item} ${active ? styles.itemActive : ''} ${session.unread && !active ? styles.itemUnread : ''}`}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_SESSION, session.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => openSession(session)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(session, { x: e.clientX, y: e.clientY })
      }}
      title={`${session.title}\n${dir}`}
    >
      <StatusDot session={session} />
      <div className={styles.itemMain}>
        {isRenaming ? (
          <RenameInput
            initial={session.title}
            onDone={(title) => {
              stopRename()
              if (title !== undefined && title.trim() !== session.title) void renameSession(session.id, title)
            }}
          />
        ) : (
          <div className={styles.itemTitle}>{session.title}</div>
        )}
        <div className={styles.itemMeta}>
          {session.worktree && <span className={styles.wtBadge}>wt</span>}
          <span className={styles.itemFolder}>{shortFolder(dir)}</span>
          <span>·</span>
          <span className={styles.itemTime}>{relativeTime(session.updatedAt, now)}</span>
        </div>
        {snippet && <div className={styles.itemSnippet}>{snippet}</div>}
      </div>
      <button
        className={`icon-btn ${styles.itemMore}`}
        title="Mais ações"
        onClick={(e) => {
          e.stopPropagation()
          onMenu(session, anchorBelow(e.currentTarget))
        }}
      >
        <MoreIcon />
      </button>
    </div>
  )
}

function Section(props: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  drop?: DropTarget
  group?: Group
  onHeaderMenu?: (at: MenuAnchor) => void
  onGroupDrop?: (groupId: string) => void
  onDropSession: (sessionId: string, target: DropTarget) => void
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const { drop, group } = props

  const accepts = (e: React.DragEvent) =>
    (drop && e.dataTransfer.types.includes(DND_SESSION)) || (group && e.dataTransfer.types.includes(DND_GROUP))

  return (
    <section
      className={`${styles.section} ${over ? styles.sectionOver : ''}`}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        const sessionId = e.dataTransfer.getData(DND_SESSION)
        const groupId = e.dataTransfer.getData(DND_GROUP)
        if (sessionId && drop) {
          e.preventDefault()
          props.onDropSession(sessionId, drop)
        } else if (groupId && group && groupId !== group.id) {
          e.preventDefault()
          props.onGroupDrop?.(groupId)
        }
      }}
    >
      <div
        className={styles.sectionHeader}
        draggable={!!group}
        onDragStart={(e) => {
          if (!group) return
          e.dataTransfer.setData(DND_GROUP, group.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={props.onToggle}
        onContextMenu={(e) => {
          if (!props.onHeaderMenu) return
          e.preventDefault()
          props.onHeaderMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <ChevronIcon open={props.open} />
        <span className={styles.sectionTitle}>{props.title}</span>
        <span className={styles.sectionCount}>{props.count}</span>
        {props.onHeaderMenu && (
          <button
            className={`icon-btn ${styles.sectionMore}`}
            title="Ações do grupo"
            onClick={(e) => {
              e.stopPropagation()
              props.onHeaderMenu?.(anchorBelow(e.currentTarget))
            }}
          >
            <MoreIcon />
          </button>
        )}
      </div>
      {props.open && <div className={styles.sectionBody}>{props.children}</div>}
    </section>
  )
}

function useTranscriptSearch(query: string) {
  const [result, setResult] = useState<{ query: string; hits: SearchHit[]; loading: boolean }>({
    query: '',
    hits: [],
    loading: false
  })
  const seq = useRef(0)

  const run = useCallback((q: string) => {
    const trimmed = q.trim()
    const id = ++seq.current
    if (!trimmed) return setResult({ query: '', hits: [], loading: false })
    setResult((r) => ({ ...r, loading: true }))
    bridge
      .invoke(ENGINE.search, trimmed)
      .then((hits) => id === seq.current && setResult({ query: trimmed, hits: hits ?? [], loading: false }))
      .catch((err) => {
        console.warn('[sessions] transcript search failed', err)
        if (id === seq.current) setResult({ query: trimmed, hits: [], loading: false })
      })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => run(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, run])

  return { ...result, runNow: () => run(query) }
}

function ProjectsFooter({ projects, sessions }: { projects: Project[]; sessions: Session[] }) {
  const [open, setOpen] = useState(true)
  const [menu, setMenu] = useState<MenuState>()
  const openDialog = useSessionsUi((s) => s.openDialog)
  const setDraft = useSessionsUi((s) => s.setDraft)
  const sorted = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [projects])

  const newSessionIn = (p: Project) => {
    setDraft({ projectId: p.id, cwd: p.cwd })
    useUi.getState().selectSession(undefined)
  }

  const projectMenu = (p: Project): MenuItem[] => [
    { label: 'Nova sessão neste projeto', onSelect: () => newSessionIn(p) },
    { label: 'Editar…', onSelect: () => openDialog({ kind: 'project', project: p }) },
    { separator: true },
    { label: 'Excluir…', danger: true, onSelect: () => openDialog({ kind: 'deleteProject', project: p }) }
  ]

  return (
    <div className={styles.footer}>
      <div className={styles.footerHeader} onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} />
        <span className={styles.sectionTitle}>Projetos</span>
        <span className={styles.sectionCount}>{projects.length}</span>
        <button
          className={`icon-btn ${styles.sectionMore} ${styles.alwaysVisible}`}
          title="Novo projeto"
          onClick={(e) => {
            e.stopPropagation()
            openDialog({ kind: 'project' })
          }}
        >
          <PlusIcon />
        </button>
      </div>
      {open && (
        <div className={styles.projectList}>
          {sorted.length === 0 && (
            <div className={styles.emptyHint}>Agrupe sessões por pasta com instruções próprias.</div>
          )}
          {sorted.map((p) => {
            const count = sessions.filter((s) => s.projectId === p.id && !s.archived).length
            return (
              <div
                key={p.id}
                className={styles.project}
                title={`${p.cwd}\nClique para iniciar uma sessão neste projeto`}
                onClick={() => newSessionIn(p)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ items: projectMenu(p), at: { x: e.clientX, y: e.clientY } })
                }}
              >
                <FolderIcon />
                <span className={styles.projectName}>{p.name}</span>
                <span className={styles.sectionCount}>{count || ''}</span>
                <button
                  className={`icon-btn ${styles.itemMore}`}
                  title="Ações do projeto"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenu({ items: projectMenu(p), at: anchorBelow(e.currentTarget) })
                  }}
                >
                  <MoreIcon />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button className={styles.footerBtn} onClick={() => openDialog({ kind: 'import' })}>
        <ImportIcon />
        Importar sessões do Claude Code
      </button>
      {menu && <ContextMenu items={menu.items} at={menu.at} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

export function Sidebar() {
  useSessionShortcuts()
  const sessions = useCollection('sessions')
  const groups = useCollection('groups')
  const projects = useCollection('projects')
  const activeId = useUi((s) => s.activeSessionId)
  const openDialog = useSessionsUi((s) => s.openDialog)
  const now = useNow(30_000)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState>()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ archived: true })
  const search = useTranscriptSearch(query)
  const searchRef = useRef<HTMLInputElement>(null)

  const sortedGroups = useMemo(() => [...groups].sort((a, b) => a.order - b.order), [groups])
  const groupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups])

  const layout = useMemo(() => {
    const live = sessions.filter((s) => !s.archived)
    const pinned = live.filter((s) => s.pinned).sort(byUpdatedDesc)
    const byGroup = new Map<string, Session[]>()
    for (const s of live) {
      if (s.pinned || !s.groupId || !groupIds.has(s.groupId)) continue
      byGroup.set(s.groupId, [...(byGroup.get(s.groupId) ?? []), s])
    }
    for (const list of byGroup.values()) list.sort(byUpdatedDesc)
    const recent = live.filter((s) => !s.pinned && !(s.groupId && groupIds.has(s.groupId))).sort(byUpdatedDesc)
    const archived = sessions.filter((s) => s.archived).sort(byUpdatedDesc)
    return { pinned, byGroup, recent, archived }
  }, [sessions, groupIds])

  const q = query.trim().toLowerCase()
  const titleHits = useMemo(
    () => (q ? [...sessions].filter((s) => s.title.toLowerCase().includes(q)).sort(byUpdatedDesc) : []),
    [sessions, q]
  )
  const transcriptHits = useMemo(() => {
    if (!q || search.query.toLowerCase() !== q) return []
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const seen = new Set<string>()
    return search.hits.flatMap((h) => {
      const s = byId.get(h.sessionId)
      if (!s || seen.has(s.id)) return []
      seen.add(s.id)
      return [{ session: s, snippet: h.snippet }]
    })
  }, [search, sessions, q])

  // Expose the visible order for Ctrl+Shift+↑/↓.
  useEffect(() => {
    const ids = q
      ? [...titleHits.map((s) => s.id), ...transcriptHits.map((h) => h.session.id)]
      : [
          ...(collapsed.pinned ? [] : layout.pinned),
          ...sortedGroups.flatMap((g) => (g.collapsed ? [] : (layout.byGroup.get(g.id) ?? []))),
          ...(collapsed.recent ? [] : layout.recent),
          ...(collapsed.archived ? [] : layout.archived)
        ].map((s) => s.id)
    setVisibleOrder([...new Set(ids)])
    return () => setVisibleOrder(undefined)
  }, [q, titleHits, transcriptHits, layout, sortedGroups, collapsed])

  const onMenu = useCallback(
    (session: Session, at: MenuAnchor) => setMenu({ items: sessionMenu(session, groups, 'sidebar'), at }),
    [groups]
  )

  const onDropSession = useCallback(
    (sessionId: string, target: DropTarget) => {
      const s = sessions.find((x) => x.id === sessionId)
      if (s) void dropSession(s, target)
    },
    [sessions]
  )

  const groupMenu = (g: Group, index: number): MenuItem[] => [
    { label: 'Renomear…', onSelect: () => openDialog({ kind: 'renameGroup', group: g }) },
    { label: 'Mover para cima', disabled: index === 0, onSelect: () => void reorderGroup(groups, g.id, index - 1) },
    {
      label: 'Mover para baixo',
      disabled: index === sortedGroups.length - 1,
      onSelect: () => void reorderGroup(groups, g.id, index + 1)
    },
    { label: 'Novo grupo…', onSelect: () => openDialog({ kind: 'newGroup' }) },
    { separator: true },
    { label: 'Excluir grupo…', danger: true, onSelect: () => openDialog({ kind: 'deleteGroup', group: g }) }
  ]

  const item = (s: Session, snippet?: string) => (
    <SessionItem key={s.id} session={s} active={s.id === activeId} now={now} snippet={snippet} onMenu={onMenu} />
  )
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))
  const empty = sessions.length === 0

  return (
    <div className={styles.sidebar}>
      <div className={styles.top}>
        <button
          className={styles.newBtn}
          onClick={() => useUi.getState().selectSession(undefined)}
          title="Nova sessão (Ctrl+N)"
        >
          <PlusIcon />
          <span>Nova sessão</span>
          <kbd className={styles.kbd}>Ctrl+N</kbd>
        </button>
        <div className={styles.search}>
          <SearchIcon />
          <input
            ref={searchRef}
            className={styles.searchInput}
            placeholder="Buscar sessões"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search.runNow()
              else if (e.key === 'Escape') {
                setQuery('')
                searchRef.current?.blur()
              }
            }}
          />
          {query && (
            <button className={styles.searchClear} title="Limpar" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
      </div>

      <div className={styles.list}>
        {q ? (
          <>
            <div className={styles.resultsLabel}>Títulos</div>
            {titleHits.length ? (
              titleHits.map((s) => item(s))
            ) : (
              <div className={styles.emptyHint}>Nenhum título corresponde.</div>
            )}
            <div className={styles.resultsLabel}>
              Nas transcrições {search.loading && <span className={styles.spinnerSmall} />}
            </div>
            {transcriptHits.map((h) => item(h.session, h.snippet))}
            {!search.loading && search.query && !transcriptHits.length && (
              <div className={styles.emptyHint}>Nada encontrado nas conversas.</div>
            )}
          </>
        ) : empty ? (
          <div className={styles.emptyState}>
            <div>Nenhuma sessão ainda.</div>
            <div className="muted">Comece uma nova ou importe do Claude Code.</div>
          </div>
        ) : (
          <>
            {layout.pinned.length > 0 && (
              <Section
                title="Fixadas"
                count={layout.pinned.length}
                open={!collapsed.pinned}
                onToggle={() => toggle('pinned')}
                drop={{ kind: 'pinned' }}
                onDropSession={onDropSession}
              >
                {layout.pinned.map((s) => item(s))}
              </Section>
            )}
            {sortedGroups.map((g, i) => {
              const list = layout.byGroup.get(g.id) ?? []
              return (
                <Section
                  key={g.id}
                  title={g.name}
                  count={list.length}
                  open={!g.collapsed}
                  onToggle={() => void setGroupCollapsed(g, !g.collapsed)}
                  drop={{ kind: 'group', groupId: g.id }}
                  group={g}
                  onHeaderMenu={(at) => setMenu({ items: groupMenu(g, i), at })}
                  onGroupDrop={(dragged) => void reorderGroup(groups, dragged, i)}
                  onDropSession={onDropSession}
                >
                  {list.length ? (
                    list.map((s) => item(s))
                  ) : (
                    <div className={styles.emptyHint}>Arraste sessões para cá.</div>
                  )}
                </Section>
              )
            })}
            <Section
              title="Recentes"
              count={layout.recent.length}
              open={!collapsed.recent}
              onToggle={() => toggle('recent')}
              drop={{ kind: 'recent' }}
              onHeaderMenu={(at) =>
                setMenu({ items: [{ label: 'Novo grupo…', onSelect: () => openDialog({ kind: 'newGroup' }) }], at })
              }
              onDropSession={onDropSession}
            >
              {layout.recent.length ? (
                layout.recent.map((s) => item(s))
              ) : (
                <div className={styles.emptyHint}>Nada por aqui.</div>
              )}
            </Section>
            <Section
              title="Arquivadas"
              count={layout.archived.length}
              open={!collapsed.archived}
              onToggle={() => toggle('archived')}
              drop={{ kind: 'archived' }}
              onDropSession={onDropSession}
            >
              {layout.archived.length ? (
                layout.archived.map((s) => item(s))
              ) : (
                <div className={styles.emptyHint}>Nenhuma sessão arquivada.</div>
              )}
            </Section>
          </>
        )}
      </div>

      <ProjectsFooter projects={projects} sessions={sessions} />
      {menu && <ContextMenu items={menu.items} at={menu.at} onClose={() => setMenu(undefined)} />}
    </div>
  )
}
