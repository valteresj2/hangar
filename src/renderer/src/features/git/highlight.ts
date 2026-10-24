// Lazy shiki highlighter. Uses the JavaScript regex engine: the renderer CSP forbids wasm.
import type { HighlighterGeneric } from 'shiki'

type Highlighter = HighlighterGeneric<string, string>

const THEMES = { light: 'github-light', dark: 'github-dark' } as const
/** Above this, highlighting gets slow enough to block the UI; fall back to plain text. */
export const HIGHLIGHT_LIMIT = 300 * 1024

const EXT_ALIASES: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yml: 'yaml',
  htm: 'html',
  svg: 'xml',
  csproj: 'xml',
  lock: 'json',
  jsonc: 'jsonc',
  gitignore: 'shellscript',
  env: 'dotenv',
  txt: 'text',
  log: 'log'
}

const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.editorconfig': 'ini',
  '.npmrc': 'ini'
}

let highlighter: Promise<Highlighter> | undefined
let languages: Promise<Set<string>> | undefined

function load(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const shiki = await import('shiki')
    return (await shiki.createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [],
      engine: shiki.createJavaScriptRegexEngine()
    })) as Highlighter
  })()
  return highlighter
}

function knownLanguages(): Promise<Set<string>> {
  languages ??= import('shiki').then(
    (s) => new Set([...Object.keys(s.bundledLanguages), ...Object.keys(s.bundledLanguagesAlias)])
  )
  return languages
}

export async function languageFor(fileName: string): Promise<string> {
  const lower = fileName.toLowerCase()
  if (FILENAME_LANG[lower]) return FILENAME_LANG[lower]
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  const candidate = EXT_ALIASES[ext] ?? ext
  return candidate && (await knownLanguages()).has(candidate) ? candidate : 'text'
}

/** Returns shiki HTML (`<pre class="shiki">` with one `.line` span per line) or undefined for plain text. */
export async function highlight(code: string, fileName: string): Promise<string | undefined> {
  if (code.length > HIGHLIGHT_LIMIT) return undefined
  const lang = await languageFor(fileName)
  if (lang === 'text' || lang === 'log') return undefined
  const hl = await load()
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang as never)
  return hl.codeToHtml(code, { lang, themes: THEMES, defaultColor: 'light' })
}
