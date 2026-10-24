// Lazy shiki highlighting. Both themes are emitted as CSS variables so light/dark switch without re-highlighting.
// Uses shiki's JavaScript regex engine: the renderer CSP does not allow WebAssembly (Oniguruma).
import type { BundledLanguage, Highlighter } from 'shiki'

let highlighterPromise: Promise<{ shiki: typeof import('shiki'); hl: Highlighter }> | undefined
const cache = new Map<string, string>()
const failedLangs = new Set<string>()
const MAX_CODE = 60_000

function load() {
  highlighterPromise ??= import('shiki').then(async (shiki) => ({
    shiki,
    hl: await shiki.createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [],
      engine: shiki.createJavaScriptRegexEngine()
    })
  }))
  return highlighterPromise
}

export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
  if (code.length > MAX_CODE) return undefined
  const key = `${lang ?? ''}\u0000${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const { shiki, hl } = await load()

  let language = (lang ?? '').toLowerCase()
  const known = language in shiki.bundledLanguages || language in shiki.bundledLanguagesAlias
  if (!known || failedLangs.has(language)) language = 'text'
  if (language !== 'text' && !hl.getLoadedLanguages().includes(language)) {
    try {
      await hl.loadLanguage(language as BundledLanguage)
    } catch {
      failedLangs.add(language)
      language = 'text'
    }
  }

  let html: string
  try {
    html = hl.codeToHtml(code, { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
  } catch {
    // A grammar the JS engine cannot run: remember it and show plain text.
    failedLangs.add(language)
    return undefined
  }
  if (cache.size > 300) cache.clear()
  cache.set(key, html)
  return html
}

/** Language id for a file path, used to highlight file contents shown in tool cards. */
export function langForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext || ext === path.toLowerCase()) return undefined
  const map: Record<string, string> = { ps1: 'powershell', psm1: 'powershell', yml: 'yaml', md: 'markdown', h: 'c', hpp: 'cpp' }
  return map[ext] ?? ext
}
