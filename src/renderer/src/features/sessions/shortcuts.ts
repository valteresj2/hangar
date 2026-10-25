// Window-level shortcuts owned by sessions: Ctrl+N, Ctrl+B, Ctrl+Shift+↑/↓.
// Installed once (capture phase, so focused widgets like xterm don't swallow them) by whichever sessions
// component mounts first; the sidebar may be hidden, so it can't be the only owner.
import { useEffect } from 'react'
import type { Session } from '@shared/contracts'
import { api } from '../../core/api'
import { useUi } from '../../core/ui'
import { openSession } from './actions'
import { byUpdatedDesc } from './util'

/** DOM event asking the new-session composer to take focus (Ctrl+N while it is already shown). */
export const FOCUS_NEW_SESSION_EVENT = 'hangar:sessions:focus-new'

/** Session ids in the order the sidebar shows them; set by the sidebar while mounted. */
let visibleOrder: string[] | undefined

export function setVisibleOrder(ids: string[] | undefined): void {
  visibleOrder = ids
}

async function step(dir: 1 | -1): Promise<void> {
  const sessions = await api.list('sessions')
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const order: Session[] = visibleOrder
    ? visibleOrder.flatMap((id) => byId.get(id) ?? [])
    : sessions.filter((s) => !s.archived).sort(byUpdatedDesc)
  if (!order.length) return
  const current = useUi.getState().activeSessionId
  const index = order.findIndex((s) => s.id === current)
  const next =
    index < 0 ? (dir === 1 ? order[0] : order[order.length - 1]) : order[(index + dir + order.length) % order.length]
  openSession(next)
}

function onKeyDown(e: KeyboardEvent): void {
  if (!e.ctrlKey || e.altKey || e.metaKey) return
  const ui = useUi.getState()
  if (ui.settingsOpen) return
  const key = e.key.toLowerCase()
  if (!e.shiftKey && key === 'n') {
    e.preventDefault()
    ui.selectSession(undefined)
    // If the view is already mounted it won't remount; ask it to refocus.
    setTimeout(() => window.dispatchEvent(new Event(FOCUS_NEW_SESSION_EVENT)))
  } else if (!e.shiftKey && key === 'b') {
    e.preventDefault()
    if (!e.repeat) ui.toggleSidebar()
  } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    void step(e.key === 'ArrowDown' ? 1 : -1)
  }
}

let installed = false

export function useSessionShortcuts(): void {
  useEffect(() => {
    if (installed) return
    installed = true
    window.addEventListener('keydown', onKeyDown, true)
  }, [])
}
