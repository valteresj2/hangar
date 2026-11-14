// One `python -m hangar bridge` process per session: newline-delimited JSON on its stdin/stdout
// (protocol in resources/harness/hangar/bridge.py). The API key travels in the environment, never in a message.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { findPython, harnessDir, harnessHome } from './locate'

/** An event from the harness. Loosely typed on purpose: unknown event types are ignored by the runner. */
export interface BridgeEvent {
  type: string
  [key: string]: unknown
}

export interface BridgeStart {
  cwd: string
  model: string
  base_url?: string
  permission: string
  effort?: string
  system_append?: string
  mcp_servers?: Record<string, { url: string; headers?: Record<string, string> }>
  resume?: string
  title?: string
  context_window?: number
  /** The folder is the user's own project: its .claude/settings.json hooks may run. */
  trust_project?: boolean
  /** Harness tool names this conversation may use ([] = none). */
  allowed_tools?: string[]
  /** File tools may not leave `cwd`. */
  confine?: boolean
  max_steps?: number
  /** Keep verified facts about the project in `<cwd>/.hangar/memory` and start each conversation knowing them. */
  memory?: boolean
}

export interface BridgeOptions {
  start: BridgeStart
  /** Secret of the provider profile; becomes HANGAR_BRIDGE_KEY. */
  apiKey?: string
  onEvent(ev: BridgeEvent): void
  /** The process ended (cleanly or not). `stderr` is the tail of what it printed there. */
  onExit(code: number | null, stderr: string): void
}

export class HangarBridge {
  private child: ChildProcessWithoutNullStreams
  private stderrTail: string[] = []
  private closed = false

  constructor(private readonly opts: BridgeOptions) {
    const python = findPython()
    const home = harnessHome()
    mkdirSync(home, { recursive: true })
    this.child = spawn(python.cmd, [...python.args, '-u', '-m', 'hangar', 'bridge'], {
      cwd: opts.start.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: harnessDir(),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HANGAR_HOME: home,
        ...(opts.apiKey ? { HANGAR_BRIDGE_KEY: opts.apiKey } : {})
      }
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (!line.trim()) return
      try {
        opts.onEvent(JSON.parse(line) as BridgeEvent)
      } catch {
        // Not protocol (should not happen: the bridge redirects stray prints to stderr).
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (data: string) => {
      this.stderrTail.push(data)
      if (this.stderrTail.length > 30) this.stderrTail.shift()
    })
    this.child.on('error', (err) => {
      this.stderrTail.push(String(err))
    })
    this.child.on('close', (code) => {
      this.closed = true
      opts.onExit(code, this.stderrTail.join('').trim().split('\n').slice(-8).join('\n'))
    })
    this.send({ type: 'start', ...opts.start })
  }

  get alive(): boolean {
    return !this.closed
  }

  send(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Asks the harness to finish (it saves the session) and makes sure the process is gone shortly after. */
  close(): void {
    if (this.closed) return
    this.send({ type: 'close' })
    try {
      this.child.stdin.end()
    } catch {
      // Already closed.
    }
    const child = this.child
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) child.kill()
    }, 4000).unref()
  }
}
