// One browser tab: an imperatively created <webview> (the partition must be set before the
// first navigation, which JSX attribute ordering does not guarantee).
import { useEffect, useRef } from 'react'
import { BROWSER_PARTITION } from '@shared/features/preview'
import { useBrowser, type BrowserTab } from './store'
import { navState, readyWebviews, webviews, type WebviewElement, type WebviewEvent } from './webview'
import styles from './preview.module.css'

export function WebviewTab({ sessionId, tab, active }: { sessionId: string; tab: BrowserTab; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const initialUrl = useRef(tab.url)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const tabId = tab.id
    const update = (patch: Partial<BrowserTab>) => useBrowser.getState().updateTab(sessionId, tabId, patch)

    const el = document.createElement('webview') as WebviewElement
    el.setAttribute('partition', BROWSER_PARTITION)
    el.setAttribute('allowpopups', '')
    el.setAttribute('src', initialUrl.current)
    el.className = styles.webview

    const listeners: [string, (e: WebviewEvent) => void][] = [
      [
        'dom-ready',
        () => {
          readyWebviews.add(tabId)
          update(navState(tabId))
        }
      ],
      ['did-start-loading', () => update({ loading: true, error: undefined })],
      ['did-stop-loading', () => update({ loading: false, ...navState(tabId) })],
      ['did-navigate', (e) => update({ url: e.url ?? '', favicon: undefined, ...navState(tabId) })],
      [
        'did-navigate-in-page',
        (e) => {
          if (e.isMainFrame) update({ url: e.url ?? '', ...navState(tabId) })
        }
      ],
      ['page-title-updated', (e) => update({ title: e.title || el.getURL() })],
      ['page-favicon-updated', (e) => update({ favicon: e.favicons?.find((f) => /^(https:|data:)/.test(f)) })],
      [
        'did-fail-load',
        (e) => {
          // -3 = ERR_ABORTED (navigation replaced by another one); not a real failure.
          if (!e.isMainFrame || e.errorCode === -3) return
          update({
            loading: false,
            error: `${e.errorDescription || 'Falha ao carregar'} (${e.errorCode})`,
            url: e.validatedURL ?? tab.url
          })
        }
      ]
    ]
    for (const [name, fn] of listeners) el.addEventListener(name, fn)

    host.appendChild(el)
    webviews.set(tabId, el)
    return () => {
      for (const [name, fn] of listeners) el.removeEventListener(name, fn)
      webviews.delete(tabId)
      readyWebviews.delete(tabId)
      el.remove()
    }
    // The webview lives as long as the tab; later URL changes come from the webview itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tab.id])

  return (
    <div className={`${styles.webviewHost} ${active ? '' : styles.inactive}`} ref={hostRef}>
      {tab.error && active && (
        <div className={styles.loadError}>
          <strong>Não foi possível abrir a página</strong>
          <span className="muted">{tab.url}</span>
          <span className="muted">{tab.error}</span>
        </div>
      )}
    </div>
  )
}
