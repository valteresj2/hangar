// Terminal registry for the renderer.
// xterm instances live at module level (not in React) so they survive the side panel being
// hidden/unmounted and the active session changing. PTYs live in main; on a renderer reload
// we re-adopt them from `terminal:list`, replaying their recent output.

import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { create } from 'zustand'
import type { Session } from '@shared/contracts'
import {
  TERMINAL,
  type CreateTerminalOptions,
  type ShellInfo,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalInfo,
  type TerminalSnapshot
} from '@shared/features/terminal'
import { api, bridge } from '../../core/api'
import { onThemeChange, terminalFont, terminalTheme } from './theme'

export interface TabMeta {
  id: string
  sessionId: string
  title: string
  shellId: string
  /** Set once the process exited by itself. */
  exitCode?: number
}

interface TerminalState {
  tabs: Record<string, TabMeta>
  /** Tab ids per session, in display order. */
  order: Record<string, string[]>
  active: Record<string, string | undefined>
  shells: ShellInfo[]
  /** True after the first `terminal:list` round-trip (existing PTYs adopted). */
  synced: boolean
  error?: string
}

export const useTerminals = create<TerminalState>(() => ({
  tabs: {},
  order: {},
  active: {},
  shells: [],
  synced: false
}))

export const NO_TABS: string[] = []

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  opened: boolean
  /** Last output chunk written, to drop duplicates after a snapshot replay. */
  seq: number
}

const entries = new Map<string, Entry>()
/** Output for ids we have not adopted yet (should be rare: `created` precedes data). */
const orphans = new Map<string, TerminalDataEvent[]>()
const LAST_SHELL_KEY = 'hangar.terminal.lastShell'

export function sessionCwd(session: Session): string {
  return session.worktree?.path ?? session.cwd
}

// ---------------------------------------------------------------------------
// Clipboard / key handling

function copySelection(term: Terminal): boolean {
  const text = term.getSelection()
  if (!text) return false
  void navigator.clipboard.writeText(text)
  term.clearSelection()
  return true
}

function pasteClipboard(term: Terminal): void {
  void navigator.clipboard.readText().then((text) => text && term.paste(text))
}

function keyHandler(term: Terminal) {
  return (e: KeyboardEvent): boolean => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return true
    const key = e.key.toLowerCase()
    // Ctrl+C copies when there is a selection, otherwise it is sent to the shell (SIGINT).
    if (key === 'c' && (e.shiftKey || term.hasSelection())) {
      if (e.type === 'keydown') copySelection(term)
      return false
    }
    if (key === 'v') {
      if (e.type === 'keydown') {
        e.preventDefault() // avoid the native paste event pasting a second time
        pasteClipboard(term)
      }
      return false
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// xterm instances

let themeWatch: (() => void) | undefined

function ensureThemeWatch(): void {
  themeWatch ??= onThemeChange(() => {
    const theme = terminalTheme()
    for (const entry of entries.values()) entry.term.options.theme = theme
  })
}

function createEntry(info: TerminalInfo, buffer: string, seq: number): Entry {
  ensureThemeWatch()
  const term = new Terminal({
    fontFamily: terminalFont(),
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
    windowsPty: bridge.platform === 'win32' ? { backend: 'conpty' } : undefined
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => void api.openExternal(uri)))
  term.attachCustomKeyEventHandler(keyHandler(term))
  term.onData((data) => void bridge.invoke(TERMINAL.write, info.id, data))
  term.onBinary((data) => void bridge.invoke(TERMINAL.write, info.id, data))
  term.onResize(({ cols, rows }) => void bridge.invoke(TERMINAL.resize, info.id, cols, rows))

  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  // Right click: copy the selection if any, otherwise paste (Windows Terminal style).
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!copySelection(term)) pasteClipboard(term)
  })

  const entry: Entry = { id: info.id, term, fit, host, opened: false, seq }
  if (buffer) term.write(buffer)
  for (const ev of orphans.get(info.id) ?? []) writeData(entry, ev)
  orphans.delete(info.id)
  entries.set(info.id, entry)
  return entry
}

function writeData(entry: Entry, ev: TerminalDataEvent): void {
  if (ev.seq <= entry.seq) return
  entry.seq = ev.seq
  entry.term.write(ev.data)
}

function disposeEntry(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  entry.host.remove()
  entry.term.dispose()
}

/** Resize the terminal to its host, skipping while the host is hidden (0×0). */
export function fitTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry || !entry.opened || !entry.host.isConnected) return
  if (entry.host.clientWidth === 0 || entry.host.clientHeight === 0) return
  const dims = entry.fit.proposeDimensions()
  if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return
  if (dims.cols !== entry.term.cols || dims.rows !== entry.term.rows) entry.fit.fit()
}

/** Moves the terminal's DOM into `container` (opening xterm the first time). */
export function attachTerminal(id: string, container: HTMLElement): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (!entry.opened) {
    entry.term.open(entry.host)
    entry.opened = true
  } else {
    entry.term.refresh(0, entry.term.rows - 1)
  }
  fitTerminal(id)
}

export function detachTerminal(id: string): void {
  entries.get(id)?.host.remove()
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

// ---------------------------------------------------------------------------
// Tabs state

function adopt(info: TerminalInfo, buffer = '', seq = 0, activate = true): void {
  if (entries.has(info.id)) return
  createEntry(info, buffer, seq)
  useTerminals.setState((s) => {
    const ids = s.order[info.sessionId] ?? []
    return {
      tabs: {
        ...s.tabs,
        [info.id]: { id: info.id, sessionId: info.sessionId, title: info.title, shellId: info.shellId }
      },
      order: { ...s.order, [info.sessionId]: [...ids, info.id] },
      active: activate || !s.active[info.sessionId] ? { ...s.active, [info.sessionId]: info.id } : s.active
    }
  })
}

function dropTab(id: string): void {
  disposeEntry(id)
  useTerminals.setState((s) => {
    const tab = s.tabs[id]
    if (!tab) return s
    const { [id]: _removed, ...tabs } = s.tabs
    const ids = s.order[tab.sessionId] ?? []
    const index = ids.indexOf(id)
    const rest = ids.filter((x) => x !== id)
    const active = { ...s.active }
    if (active[tab.sessionId] === id) active[tab.sessionId] = rest[Math.min(index, rest.length - 1)]
    return { tabs, order: { ...s.order, [tab.sessionId]: rest }, active }
  })
}

export function setActiveTab(sessionId: string, id: string): void {
  useTerminals.setState((s) => ({ active: { ...s.active, [sessionId]: id } }))
}

export function renameTab(id: string, title: string): void {
  const clean = title.trim()
  if (!clean) return
  useTerminals.setState((s) => (s.tabs[id] ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], title: clean } } } : s))
  void bridge.invoke(TERMINAL.rename, id, clean)
}

export function closeTab(id: string): void {
  const exited = useTerminals.getState().tabs[id]?.exitCode !== undefined
  dropTab(id)
  if (!exited) void bridge.invoke(TERMINAL.kill, id)
}

export function lastShell(): string | undefined {
  try {
    return localStorage.getItem(LAST_SHELL_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Spawns a PTY for the session; the tab appears via the `created` event. */
export async function openTerminal(session: Session, shell?: string): Promise<void> {
  const { order, active } = useTerminals.getState()
  // Size from a sibling terminal if any; the real size is applied once the tab is attached and fitted.
  const sibling = entries.get(active[session.id] ?? order[session.id]?.[0] ?? '')
  const opts: CreateTerminalOptions = {
    sessionId: session.id,
    cwd: sessionCwd(session),
    shell: shell ?? lastShell(),
    cols: sibling?.term.cols ?? 80,
    rows: sibling?.term.rows ?? 24
  }
  if (shell) {
    try {
      localStorage.setItem(LAST_SHELL_KEY, shell)
    } catch {
      // Storage unavailable: just don't remember the choice.
    }
  }
  try {
    const info = await bridge.invoke<TerminalInfo>(TERMINAL.create, opts)
    adopt(info) // no-op when the `created` event already did it
    useTerminals.setState({ error: undefined })
  } catch (err) {
    const message =
      err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    useTerminals.setState({ error: `Não foi possível abrir o terminal: ${message}` })
  }
}

// ---------------------------------------------------------------------------
// IPC wiring (once per renderer)

let started = false

export function startTerminals(): void {
  if (started) return
  started = true

  bridge.on(TERMINAL.created, (info: TerminalInfo) => adopt(info))
  bridge.on(TERMINAL.data, (ev: TerminalDataEvent) => {
    const entry = entries.get(ev.id)
    if (entry) return writeData(entry, ev)
    const queued = orphans.get(ev.id) ?? []
    queued.push(ev)
    orphans.set(ev.id, queued)
  })
  bridge.on(TERMINAL.exit, (ev: TerminalExitEvent) => {
    orphans.delete(ev.id)
    const entry = entries.get(ev.id)
    if (!entry) return
    // Killed by us (tab closed / session removed) or a clean `exit`: close the tab.
    if (ev.killed || ev.code === 0) return dropTab(ev.id)
    entry.term.write(`\r\n\x1b[90m[Processo encerrado com código ${ev.code}]\x1b[0m\r\n`)
    useTerminals.setState((s) =>
      s.tabs[ev.id] ? { tabs: { ...s.tabs, [ev.id]: { ...s.tabs[ev.id], exitCode: ev.code } } } : s
    )
  })

  void Promise.all([
    bridge.invoke<ShellInfo[]>(TERMINAL.shells).catch(() => [] as ShellInfo[]),
    bridge.invoke<TerminalSnapshot[]>(TERMINAL.list).catch(() => [] as TerminalSnapshot[])
  ]).then(([shells, snapshots]) => {
    for (const snap of snapshots) adopt(snap, snap.buffer, snap.seq, false)
    useTerminals.setState({ shells, synced: true })
  })
}
