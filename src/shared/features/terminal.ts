// IPC channels and payload types for the "terminal" feature. Owned by the terminal agent.
export const TERMINAL = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  rename: 'terminal:rename',
  list: 'terminal:list',
  shells: 'terminal:shells',
  /** main -> renderer: a PTY was spawned (by the renderer or by another feature via runInNewTerminal). */
  created: 'terminal:event:created',
  data: 'terminal:event:data',
  exit: 'terminal:event:exit'
} as const

export interface ShellInfo {
  /** Stable id: 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'bash' | 'zsh' | ... */
  id: string
  /** Label shown in the UI. */
  name: string
  path: string
  args: string[]
}

export interface CreateTerminalOptions {
  sessionId: string
  cwd: string
  /** ShellInfo.id; defaults to the first detected shell. */
  shell?: string
  cols: number
  rows: number
  title?: string
}

export interface TerminalInfo {
  id: string
  sessionId: string
  shellId: string
  title: string
  cwd: string
  pid: number
  createdAt: number
}

/** TerminalInfo plus the recent output, so a reloaded renderer can rebuild the screen. */
export interface TerminalSnapshot extends TerminalInfo {
  buffer: string
  /** Sequence number of the last chunk included in `buffer`. */
  seq: number
}

/** Output chunks are batched (~8 ms). `seq` increases by one per chunk, per terminal. */
export interface TerminalDataEvent {
  id: string
  data: string
  seq: number
}

export interface TerminalExitEvent {
  id: string
  code: number
  /** True when the PTY was killed by Hangar (tab closed, session removed) rather than exiting by itself. */
  killed: boolean
}

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [TERMINAL.create]: (opts: CreateTerminalOptions) => TerminalInfo
    [TERMINAL.write]: (id: string, data: string) => void
    [TERMINAL.resize]: (id: string, cols: number, rows: number) => void
    [TERMINAL.kill]: (id: string) => void
    [TERMINAL.rename]: (id: string, title: string) => void
    [TERMINAL.list]: (sessionId?: string) => TerminalSnapshot[]
    [TERMINAL.shells]: () => ShellInfo[]
  }

  interface IpcEventContract {
    [TERMINAL.created]: TerminalInfo
    [TERMINAL.data]: TerminalDataEvent
    [TERMINAL.exit]: TerminalExitEvent
  }
}
