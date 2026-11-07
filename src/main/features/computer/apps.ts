// Apps found on this computer for the picker, per system: Windows Start menu shortcuts (their target executable),
// macOS application bundles (/Applications, ~/Applications; the process is the bundle's executable), Linux desktop
// entries (.desktop files; the process is the first word of Exec), plus the windows open now and a few built-ins.
// Each comes with why it can never be allowed or the warning that goes with it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { InstalledApp } from '../../../shared/features/computer'
import type { WindowInfo } from './driver/types'
import { blockedReason, warningFor, type OsKind } from './guard'

const SYSTEM32 = join(process.env.WINDIR ?? 'C:\\Windows', 'System32')

const BUILTINS: Record<OsKind, InstalledApp[]> = {
  win32: [
    { name: 'Bloco de Notas', process: 'notepad', launch: join(SYSTEM32, 'notepad.exe'), source: 'start-menu' },
    { name: 'Paint', process: 'mspaint', launch: join(SYSTEM32, 'mspaint.exe'), source: 'start-menu' }
  ],
  darwin: [],
  linux: []
}

function walk(
  dir: string,
  match: (name: string) => boolean,
  maxDepth: number,
  depth = 0,
  out: string[] = []
): string[] {
  if (depth > maxDepth || out.length > 800) return out
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    const full = join(dir, n)
    if (match(n)) {
      out.push(full)
      continue
    }
    try {
      if (statSync(full).isDirectory()) walk(full, match, maxDepth, depth + 1, out)
    } catch {
      /* unreadable */
    }
  }
  return out
}

const decorate = (a: InstalledApp): InstalledApp => {
  const blocked = blockedReason(a.process)
  const warning = warningFor(a.process)
  return { ...a, ...(blocked ? { blocked } : {}), ...(warning ? { warning } : {}) }
}

const SKIP = /uninstall|desinstal|readme|help|ajuda|website|documenta/i

function windowsApps(readShortcut: (path: string) => string | undefined): InstalledApp[] {
  const dirs = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ].filter((d) => d && existsSync(d))
  const out: InstalledApp[] = []
  for (const dir of dirs) {
    for (const lnk of walk(dir, (n) => extname(n).toLowerCase() === '.lnk', 3)) {
      const name = basename(lnk, '.lnk')
      if (SKIP.test(name)) continue
      const target = readShortcut(lnk)
      if (!target || extname(target).toLowerCase() !== '.exe') continue
      out.push({ name, process: basename(target, extname(target)), launch: lnk, source: 'start-menu' })
    }
  }
  return out
}

/** CFBundleExecutable of an .app (XML Info.plist; a binary plist falls back to the bundle name). */
export function bundleExecutable(plist: string): string | undefined {
  return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim()
}

function macApps(): InstalledApp[] {
  const dirs = ['/Applications', '/System/Applications', join(homedir(), 'Applications')].filter((d) => existsSync(d))
  const out: InstalledApp[] = []
  for (const dir of dirs) {
    for (const app of walk(dir, (n) => n.endsWith('.app'), 1)) {
      const name = basename(app, '.app')
      if (SKIP.test(name)) continue
      let exe: string | undefined
      try {
        exe = bundleExecutable(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))
      } catch {
        /* no Info.plist */
      }
      out.push({ name, process: exe || name, launch: app, source: 'start-menu' })
    }
  }
  return out
}

/** The parts of a .desktop entry the picker needs (undefined: hidden, not an application, or no Exec). */
export function parseDesktopEntry(text: string): { name: string; process: string } | undefined {
  const section = text.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]'))
  if (!section) return undefined
  const get = (k: string): string | undefined => new RegExp(`^${k}=(.*)$`, 'm').exec(section)?.[1]?.trim()
  if (get('Type') !== 'Application' || get('NoDisplay') === 'true' || get('Hidden') === 'true') return undefined
  const exec = get('Exec')
  const name = get('Name')
  if (!exec || !name) return undefined
  const words = exec
    .replace(/%[a-zA-Z]/g, '')
    .trim()
    .split(/\s+/)
  // `env VAR=x prog`, `flatpak run org.app.Id`: the program is the meaningful word
  // (a flatpak's process is named by the app itself; the last part of its id is the best guess the entry gives)
  let i = 0
  if (basename(words[0] ?? '') === 'env') {
    i = 1
    while (words[i]?.includes('=')) i++
  }
  const prog =
    basename(words[0] ?? '') === 'flatpak'
      ? (words
          .find((w) => /^[\w.-]+\.[\w.-]+$/.test(w))
          ?.split('.')
          .pop() ?? '')
      : words[i]
  const process = basename(prog ?? '').replace(/^["']|["']$/g, '')
  return process ? { name, process } : undefined
}

function linuxApps(): InstalledApp[] {
  const dirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    join(homedir(), '.local', 'share', 'applications')
  ].filter((d) => existsSync(d))
  const out: InstalledApp[] = []
  for (const dir of dirs) {
    for (const file of walk(dir, (n) => n.endsWith('.desktop'), 1)) {
      try {
        const e = parseDesktopEntry(readFileSync(file, 'utf8'))
        if (e && !SKIP.test(e.name)) out.push({ ...e, launch: file, source: 'start-menu' })
      } catch {
        /* unreadable */
      }
    }
  }
  return out
}

/**
 * readShortcut: Electron's shell.readShortcutLink (target of a Windows .lnk). Uninstallers, help files and links to
 * documents are skipped.
 */
export function findApps(
  readShortcut: (path: string) => string | undefined,
  windows: WindowInfo[],
  os: OsKind = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32'
): InstalledApp[] {
  const seen = new Map<string, InstalledApp>()
  const add = (a: InstalledApp): void => {
    const key = a.process.toLowerCase()
    if (!key || seen.has(key)) return
    seen.set(key, decorate(a))
  }
  // the installed entry's name wins over a window's ("Bloco de Notas", not "Sem título - Bloco de Notas")
  for (const b of BUILTINS[os]) add(b)
  const installed = os === 'darwin' ? macApps() : os === 'linux' ? linuxApps() : windowsApps(readShortcut)
  for (const a of installed) add(a)
  for (const w of windows) {
    if (w.process)
      add({
        name: (os === 'win32' ? w.title.split(' - ').pop()?.trim() : '') || w.process,
        process: w.process,
        launch: w.exe,
        source: 'window'
      })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
}
