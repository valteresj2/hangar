// Embedded browser: tabs of <webview>s per session, URL bar, navigation and the dev-server menu.
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import type { DownloadEvent } from '@shared/features/preview'
import { PREVIEW } from '@shared/features/preview'
import { api, bridge } from '../../core/api'
import { ServersMenu } from './ServersMenu'
import { useServers } from './servers'
import { useBrowser, type BrowserTab } from './store'
import { normalizeInput, webviews } from './webview'
import { WebviewTab } from './WebviewTab'
import styles from './preview.module.css'

const EMPTY: BrowserTab[] = []

function tabLabel(tab: BrowserTab): string {
  if (!tab.url) return 'Nova aba'
  if (tab.title && tab.title !== tab.url) return tab.title
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}

function useDownloadNotice(): string | undefined {
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = bridge.on(PREVIEW.downloadEvent, (e: DownloadEvent) => {
      const text = {
        started: `Baixando ${e.filename}…`,
        completed: `Download concluído: ${e.savePath ?? e.filename}`,
        cancelled: `Download cancelado: ${e.filename}`,
        interrupted: `Download interrompido: ${e.filename}`
      }[e.state]
      setNotice(text)
      clearTimeout(timer)
      if (e.state !== 'started') timer = setTimeout(() => setNotice(undefined), 5000)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [])
  return notice
}

function StartPage({ sessionId, onOpen }: { sessionId: string; onOpen(url: string): void }) {
  const servers = useServers(sessionId).filter((s) => s.status === 'running' && s.url)
  return (
    <div className={styles.startPage}>
      <div className={styles.startTitle}>Nova aba</div>
      <div className="muted">Digite um endereço ou uma busca na barra acima.</div>
      {servers.length > 0 && (
        <div className={styles.startList}>
          <div className="muted">Servidores rodando</div>
          {servers.map((s) => (
            <button key={s.id} className="btn" onClick={() => onOpen(s.url!)}>
              {s.name} — {s.url}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionBrowser({ session }: { session: Session }) {
  const sessionId = session.id
  const tabs = useBrowser((s) => s.bySession[sessionId]?.tabs ?? EMPTY)
  const activeId = useBrowser((s) => s.bySession[sessionId]?.activeId)
  const { openTab, closeTab, activate, updateTab } = useBrowser.getState()
  const active = tabs.find((t) => t.id === activeId)
  const servers = useServers(sessionId)
  const runningCount = servers.filter((s) => s.status === 'running' || s.status === 'starting').length
  const [menuOpen, setMenuOpen] = useState(false)
  const [address, setAddress] = useState('')
  const editingAddress = useRef(false)
  const addressRef = useRef<HTMLInputElement>(null)
  const notice = useDownloadNotice()

  // Always have at least one tab.
  useEffect(() => {
    // Read the store directly: StrictMode re-runs effects with a stale `tabs`.
    if (!useBrowser.getState().bySession[sessionId]?.tabs.length) openTab(sessionId)
  }, [tabs.length, sessionId, openTab])

  // Mirror the active tab's URL in the address bar unless the user is typing.
  useEffect(() => {
    if (!editingAddress.current) setAddress(active?.url ?? '')
  }, [active?.id, active?.url])

  const webview = () => (active ? webviews.get(active.id) : undefined)
  const call = (fn: (el: NonNullable<ReturnType<typeof webview>>) => void) => {
    const el = webview()
    if (!el) return
    try {
      fn(el)
    } catch {
      // webview not ready yet
    }
  }

  const navigate = (raw: string) => {
    const url = normalizeInput(raw)
    if (!url) return
    if (!active) {
      openTab(sessionId, url)
      return
    }
    const el = webviews.get(active.id)
    if (el && active.url) {
      updateTab(sessionId, active.id, { url, error: undefined })
      el.loadURL(url).catch(() => {
        // failures are reported through did-fail-load
      })
    } else {
      // Start page: setting the URL mounts the webview.
      updateTab(sessionId, active.id, { url, title: url, loading: true, error: undefined })
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`${styles.tab} ${tab.id === activeId ? styles.tabActive : ''}`}
            onClick={() => activate(sessionId, tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(sessionId, tab.id)}
            title={tab.url || 'Nova aba'}
          >
            {tab.loading ? (
              <span className={styles.spinner} />
            ) : tab.favicon ? (
              <img className={styles.favicon} src={tab.favicon} alt="" />
            ) : null}
            <span className={styles.tabTitle}>{tabLabel(tab)}</span>
            <button
              className={styles.tabClose}
              title="Fechar aba"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(sessionId, tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="icon-btn" title="Nova aba" onClick={() => openTab(sessionId)}>
          +
        </button>
      </div>

      <div className={styles.toolbar}>
        <button
          className="icon-btn"
          title="Voltar"
          disabled={!active?.canGoBack}
          onClick={() => call((el) => el.goBack())}
        >
          ←
        </button>
        <button
          className="icon-btn"
          title="Avançar"
          disabled={!active?.canGoForward}
          onClick={() => call((el) => el.goForward())}
        >
          →
        </button>
        {active?.loading ? (
          <button className="icon-btn" title="Parar" onClick={() => call((el) => el.stop())}>
            ✕
          </button>
        ) : (
          <button
            className="icon-btn"
            title="Recarregar"
            disabled={!active?.url}
            onClick={() => call((el) => el.reload())}
          >
            ⟳
          </button>
        )}
        <form
          className={styles.addressForm}
          onSubmit={(e) => {
            e.preventDefault()
            editingAddress.current = false
            navigate(address)
            addressRef.current?.blur()
          }}
        >
          <input
            ref={addressRef}
            className={`input ${styles.address}`}
            value={address}
            placeholder="Pesquisar ou digitar endereço"
            spellCheck={false}
            onFocus={(e) => {
              editingAddress.current = true
              e.currentTarget.select()
            }}
            onBlur={() => {
              editingAddress.current = false
              setAddress(active?.url ?? '')
            }}
            onKeyDown={(e) => e.key === 'Escape' && addressRef.current?.blur()}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        <button
          className={`btn ${styles.serversBtn} ${menuOpen ? styles.serversBtnActive : ''}`}
          title="Servidores de desenvolvimento (.claude/launch.json)"
          onClick={() => setMenuOpen((v) => !v)}
        >
          Servidores{runningCount > 0 && <span className={styles.badge}>{runningCount}</span>}
        </button>
        <button
          className="icon-btn"
          title="Abrir no navegador do sistema"
          disabled={!active?.url || !/^https?:/i.test(active.url)}
          onClick={() => active && void api.openExternal(active.url)}
        >
          ⧉
        </button>
        <button
          className="icon-btn"
          title="DevTools da página"
          disabled={!active?.url}
          onClick={() => call((el) => (el.isDevToolsOpened() ? el.closeDevTools() : el.openDevTools()))}
        >
          {'</>'}
        </button>
      </div>

      <div className={styles.viewport}>
        {tabs.map((tab) =>
          tab.url ? (
            <WebviewTab key={tab.id} sessionId={sessionId} tab={tab} active={tab.id === activeId} />
          ) : (
            tab.id === activeId && <StartPage key={tab.id} sessionId={sessionId} onOpen={navigate} />
          )
        )}
        {menuOpen && <ServersMenu sessionId={sessionId} servers={servers} onClose={() => setMenuOpen(false)} />}
        {notice && <div className={styles.notice}>{notice}</div>}
      </div>
    </div>
  )
}

/** Side-panel tab: embedded browser with tabs and dev-server preview. */
export function BrowserPanel({ session }: { session: Session }) {
  // Keyed by session so webviews of another session are torn down; tab URLs survive in the store.
  return <SessionBrowser key={session.id} session={session} />
}
