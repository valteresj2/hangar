// A driver that talks to a native helper process over JSON lines on stdio ({"id":1,"cmd":"capture",…} →
// {"id":1,"ok":true,…}): the Windows helper (C#, windows.ts) and the macOS helper (Swift, macos.ts) speak the same
// protocol, so the same class drives both. The helper only does what the main process asks after its own checks.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { str } from '../agui'
import type {
  Capture,
  ComputerDriver,
  FocusedInfo,
  IdleReading,
  UiElement,
  WatchEvent,
  WatchOptions,
  WindowInfo
} from './types'

const TIMEOUT_MS = 20_000

type Pending = { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: NodeJS.Timeout }

export class HelperDriver implements ComputerDriver {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private seq = 0
  private buf = ''
  private starting?: Promise<void>
  /** What the helper said when it started (version; on macOS the Accessibility and Screen Recording permissions). */
  protected hello: Record<string, unknown> = {}

  constructor(
    readonly name: string,
    private readonly dir: string,
    private readonly prepare: (dir: string) => Promise<{ cmd: string; args: string[] }>,
    private readonly launcher: (target: string) => Promise<string>
  ) {}

  start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return Promise.resolve()
    this.starting ??= (async () => {
      const { cmd, args } = await this.prepare(this.dir)
      const child = spawn(cmd, args, { windowsHide: true, stdio: 'pipe' })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => this.onData(d))
      child.stderr.on('data', () => undefined)
      child.on('exit', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('o ajudante do sistema parou'))
        }
        this.pending.clear()
        if (this.child === child) this.child = undefined
      })
      this.child = child
      this.hello = await this.call('hello')
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /** The permissions the helper reported (always granted on Windows). */
  permissions(): { accessibility: boolean; screen: boolean } {
    return { accessibility: this.hello.accessibility !== false, screen: this.hello.screen !== false }
  }

  dispose(): void {
    const c = this.child
    this.child = undefined
    if (c && c.exitCode === null) {
      try {
        c.stdin.write('{"cmd":"release"}\n{"cmd":"exit"}\n')
      } catch {
        /* gone */
      }
      setTimeout(() => c.kill(), 500).unref()
    }
  }

  private onData(d: string): void {
    this.buf += d
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const p = this.pending.get(Number(msg.id))
      if (!p) continue
      this.pending.delete(Number(msg.id))
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(str(msg.error) || 'erro no ajudante do sistema'))
    }
  }

  private async call(cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.child || this.child.exitCode !== null) {
      if (cmd === 'hello') throw new Error('o ajudante do sistema não iniciou')
      await this.start()
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`o ajudante do sistema não respondeu (${cmd})`))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`)
    })
  }

  async windows(): Promise<WindowInfo[]> {
    return ((await this.call('windows')).windows as WindowInfo[]) ?? []
  }
  async foreground(): Promise<WindowInfo | undefined> {
    return ((await this.call('foreground')).window as WindowInfo | null) ?? undefined
  }
  async window(hwnd: number): Promise<WindowInfo | undefined> {
    try {
      return ((await this.call('window', { hwnd })).window as WindowInfo | null) ?? undefined
    } catch {
      return undefined
    }
  }
  async focus(hwnd: number): Promise<WindowInfo | undefined> {
    return ((await this.call('focus', { hwnd })).window as WindowInfo | null) ?? undefined
  }
  async capture(
    hwnd: number,
    opts: { maxWidth: number; allowedPids: number[]; ignoreHwnds: number[] }
  ): Promise<Capture> {
    return (await this.call('capture', { hwnd, ...opts })) as unknown as Capture
  }
  async elements(hwnd: number, max: number): Promise<UiElement[]> {
    return ((await this.call('elements', { hwnd, max, timeoutMs: 2000 })).elements as UiElement[]) ?? []
  }
  async focused(): Promise<FocusedInfo | undefined> {
    return ((await this.call('focused')).focused as FocusedInfo | null) ?? undefined
  }
  async hit(x: number, y: number, ignore: number[] = []): Promise<WindowInfo | undefined> {
    return ((await this.call('hit', { x, y, ignoreHwnds: ignore })).window as WindowInfo | null) ?? undefined
  }
  async click(x: number, y: number, opts: { button?: 'left' | 'right'; double?: boolean }): Promise<void> {
    await this.call('click', { x, y, button: opts.button ?? 'left', double: !!opts.double })
  }
  async type(text: string): Promise<void> {
    await this.call('type', { text })
  }
  async key(key: string, modifiers: string[]): Promise<void> {
    await this.call('key', { key, modifiers })
  }
  async scroll(x: number, y: number, direction: string, amount: number): Promise<void> {
    await this.call('scroll', { x, y, direction, amount })
  }
  async watchStart(opts: WatchOptions): Promise<void> {
    await this.call('watch_start', { ...opts })
  }
  async watchPoll(): Promise<WatchEvent[]> {
    return ((await this.call('watch_poll')).events as WatchEvent[]) ?? []
  }
  async watchStop(): Promise<WatchEvent[]> {
    return ((await this.call('watch_stop')).events as WatchEvent[]) ?? []
  }
  async release(): Promise<void> {
    if (this.child && this.child.exitCode === null) await this.call('release').catch(() => undefined)
  }
  async idle(): Promise<IdleReading> {
    return (await this.call('idle')) as unknown as IdleReading
  }
  async launch(target: string): Promise<void> {
    const err = await this.launcher(target)
    if (err) throw new Error(err)
  }
}
