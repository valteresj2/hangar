// Browser tabs per session (kept in memory while the app is open) and the global
// listeners that open tabs on their own: popups from a webview and dev servers becoming ready.
import { create } from 'zustand'
import { PREVIEW, type PopupEvent, type ServerEvent } from '@shared/features/preview'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'
import { webviews } from './webview'

export interface BrowserTab {
  id: string
  /** Empty for a fresh tab (shows the start page instead of a webview). */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  error?: string
}

interface SessionTabs {
  tabs: BrowserTab[]
  activeId?: string
}

interface BrowserState {
  bySession: Record<string, SessionTabs>
  openTab(sessionId: string, url?: string, activate?: boolean): string
  closeTab(sessionId: string, tabId: string): void
  activate(sessionId: string, tabId: string): void
  updateTab(sessionId: string, tabId: string, patch: Partial<BrowserTab>): void
}

let seq = 0
const newTabId = () => `tab-${Date.now().toString(36)}-${(seq++).toString(36)}`

export const useBrowser = create<BrowserState>((set) => ({
  bySession: {},
  openTab: (sessionId, url = '', activate = true) => {
    const id = newTabId()
    const tab: BrowserTab = {
      id,
      url,
      title: url ? url : 'Nova aba',
      loading: !!url,
      canGoBack: false,
      canGoForward: false
    }
    set((s) => {
      const cur = s.bySession[sessionId] ?? { tabs: [] }
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { tabs: [...cur.tabs, tab], activeId: activate || !cur.activeId ? id : cur.activeId }
        }
      }
    })
    return id
  },
  closeTab: (sessionId, tabId) =>
    set((s) => {
      const cur = s.bySession[sessionId]
      if (!cur) return s
      const index = cur.tabs.findIndex((t) => t.id === tabId)
      const tabs = cur.tabs.filter((t) => t.id !== tabId)
      const activeId = cur.activeId === tabId ? tabs[Math.min(index, tabs.length - 1)]?.id : cur.activeId
      return { bySession: { ...s.bySession, [sessionId]: { tabs, activeId } } }
    }),
  activate: (sessionId, tabId) =>
    set((s) => {
      const cur = s.bySession[sessionId]
      if (!cur) return s
      return { bySession: { ...s.bySession, [sessionId]: { ...cur, activeId: tabId } } }
    }),
  updateTab: (sessionId, tabId, patch) =>
    set((s) => {
      const cur = s.bySession[sessionId]
      if (!cur || !cur.tabs.some((t) => t.id === tabId)) return s
      const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      return { bySession: { ...s.bySession, [sessionId]: { ...cur, tabs } } }
    })
}))

function sessionOfTab(tabId: string): string | undefined {
  for (const [sessionId, { tabs }] of Object.entries(useBrowser.getState().bySession)) {
    if (tabs.some((t) => t.id === tabId)) return sessionId
  }
  return undefined
}

// Popups (window.open / target=_blank) become a new internal tab next to the tab that asked.
bridge.on(PREVIEW.popupEvent, ({ sourceId, url }: PopupEvent) => {
  let sessionId: string | undefined
  for (const [tabId, el] of webviews) {
    try {
      if (el.getWebContentsId() === sourceId) sessionId = sessionOfTab(tabId)
    } catch {
      // webview not attached yet
    }
  }
  sessionId ??= useUi.getState().activeSessionId
  if (sessionId) useBrowser.getState().openTab(sessionId, url)
})

// A dev server whose port started answering opens in a tab of its session.
bridge.on(PREVIEW.serverEvent, (event: ServerEvent) => {
  if (event.type !== 'state' || !event.ready || !event.server.url) return
  const { sessionId, url } = event.server
  const state = useBrowser.getState()
  const existing = state.bySession[sessionId]?.tabs.find((t) => t.url.replace(/\/$/, '') === url.replace(/\/$/, ''))
  if (existing) {
    state.activate(sessionId, existing.id)
    const el = webviews.get(existing.id)
    try {
      el?.reload()
    } catch {
      // not ready; it will load on its own
    }
  } else {
    state.openTab(sessionId, url)
  }
  const ui = useUi.getState()
  if (ui.activeSessionId === sessionId) ui.openSidePanel('browser')
})
