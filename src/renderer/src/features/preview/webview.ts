// Minimal typing for Electron's <webview> element (the renderer tsconfig has no Electron types).

export interface WebviewElement extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
  getWebContentsId(): number
}

/** Event fields Electron attaches to webview DOM events (only the ones we use). */
export interface WebviewEvent extends Event {
  url?: string
  title?: string
  isMainFrame?: boolean
  favicons?: string[]
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
}

/** Live <webview> elements by browser tab id, so toolbar buttons can drive them. */
export const webviews = new Map<string, WebviewElement>()
/** Tabs whose webview fired `dom-ready` (navigation methods throw before that). */
export const readyWebviews = new Set<string>()

export function navState(tabId: string): { canGoBack: boolean; canGoForward: boolean } {
  const el = webviews.get(tabId)
  if (!el || !readyWebviews.has(tabId)) return { canGoBack: false, canGoForward: false }
  try {
    return { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() }
  } catch {
    return { canGoBack: false, canGoForward: false }
  }
}

/** Turns URL-bar text into a URL: explicit http(s), localhost:port, bare domains, else a web search. */
export function normalizeInput(text: string): string | undefined {
  const value = text.trim()
  if (!value) return undefined
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(value)) return `http://${value}`
  if (/^(https?:\/\/|about:blank$)/i.test(value)) return value
  if (!/\s/.test(value) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Removes ANSI escape sequences from process output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}
