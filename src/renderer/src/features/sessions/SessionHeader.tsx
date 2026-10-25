// Top-bar actions for the active session: inline rename (double-click the title), pin, "…" menu.
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import { api } from '../../core/api'
import { useCollection } from '../../core/data'
import { renameSession, sessionMenu, setPinned } from './actions'
import { anchorBelow, ContextMenu, type MenuAnchor } from './ContextMenu'
import { SessionsOverlay } from './Dialogs'
import { BranchIcon, MoreIcon, PinIcon } from './icons'
import { useSessionShortcuts } from './shortcuts'
import { RenameInput, StatusDot } from './parts'
import { useSessionsUi } from './store'
import styles from './sessions.module.css'

export function SessionHeader({ session }: { session: Session }) {
  useSessionShortcuts()
  const groups = useCollection('groups')
  const renaming = useSessionsUi((s) => s.renaming)
  const startRename = useSessionsUi((s) => s.startRename)
  const stopRename = useSessionsUi((s) => s.stopRename)
  const [menu, setMenu] = useState<MenuAnchor>()
  const ref = useRef<HTMLSpanElement>(null)
  const isRenaming = renaming?.id === session.id && renaming.where === 'header'

  // The user is looking at this session, so it can't be unread.
  useEffect(() => {
    if (session.unread) void api.patch('sessions', session.id, { unread: false })
  }, [session.id, session.unread])

  // The title itself is rendered by the shell's TopBar right before this component. Until the shell
  // delegates it to us, hook double-click on that element and hide it while the inline editor is open.
  useEffect(() => {
    const title = ref.current?.previousElementSibling
    if (!(title instanceof HTMLElement)) return
    const onDblClick = () => startRename(session.id, 'header')
    title.addEventListener('dblclick', onDblClick)
    title.title = 'Clique duas vezes para renomear'
    title.style.cursor = 'text'
    return () => title.removeEventListener('dblclick', onDblClick)
  }, [session.id, startRename])

  useEffect(() => {
    const title = ref.current?.previousElementSibling
    if (title instanceof HTMLElement) title.style.display = isRenaming ? 'none' : ''
  }, [isRenaming])

  return (
    <span ref={ref} className={styles.header}>
      {isRenaming && (
        <RenameInput
          className={styles.headerRename}
          initial={session.title}
          onDone={(title) => {
            stopRename()
            if (title !== undefined && title.trim() !== session.title) void renameSession(session.id, title)
          }}
        />
      )}
      {session.status !== 'idle' && <StatusDot session={session} />}
      {session.worktree && (
        <span className={styles.headerBadge} title={`Worktree: ${session.worktree.path}`}>
          <BranchIcon />
          {session.worktree.branch}
        </span>
      )}
      <button
        className={`icon-btn ${session.pinned ? styles.pinOn : ''}`}
        title={session.pinned ? 'Desafixar' : 'Fixar'}
        onClick={() => void setPinned(session, !session.pinned)}
      >
        <PinIcon filled={session.pinned} />
      </button>
      <button className="icon-btn" title="Mais ações" onClick={(e) => setMenu(anchorBelow(e.currentTarget))}>
        <MoreIcon />
      </button>
      {menu && (
        <ContextMenu items={sessionMenu(session, groups, 'header')} at={menu} onClose={() => setMenu(undefined)} />
      )}
      <SessionsOverlay />
    </span>
  )
}
