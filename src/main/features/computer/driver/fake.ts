// A pretend computer for the tests and the e2e (HANGAR_COMPUTER_DRIVER=fake): a few windows, a focused field, the
// input it received and a tiny PNG as every capture. Nothing real moves. `human()` simulates the person touching the
// mouse; `script` lets a test change the screen after an action (a dialog opens, the title changes).
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

// 1×1 transparent PNG
export const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export interface FakeInput {
  kind: 'click' | 'type' | 'key' | 'scroll' | 'focus' | 'launch' | 'release'
  detail: string
}

export function fakeWindow(over: Partial<WindowInfo> & { hwnd: number; title: string; process: string }): WindowInfo {
  return {
    className: 'FakeWindow',
    pid: over.hwnd * 10,
    ownerPid: over.pid ?? over.hwnd * 10,
    exe: `C:\\Apps\\${over.process}.exe`,
    elevated: false,
    rect: { x: 100, y: 100, width: 800, height: 600 },
    minimized: false,
    foreground: false,
    ...over
  }
}

export class FakeDriver implements ComputerDriver {
  readonly name = 'fake'
  inputs: FakeInput[] = []
  wins: WindowInfo[] = []
  fg?: number
  elementsOf = new Map<number, UiElement[]>()
  focusedField?: FocusedInfo
  /** Called after each input: lets a test change the screen. */
  script?: (input: FakeInput, d: FakeDriver) => void
  /** Launch target → window that appears. */
  launches = new Map<string, WindowInfo>()
  private readonly t0 = Date.now()
  private offset = 0
  private lastInput = 0
  private lastInject = 0
  private cursor = { x: 0, y: 0 }
  locked = false
  started = 0
  /** Recording: what the watch was asked to follow, and what the "person" did (tests push with did()). */
  watching?: WatchOptions
  private watched: WatchEvent[] = []
  private watchT0 = 0

  constructor(init?: { windows?: WindowInfo[]; foreground?: number }) {
    this.wins = init?.windows ?? []
    this.fg = init?.foreground
  }

  /** The person moves the mouse / types. */
  human(): void {
    this.offset += 1000
    this.lastInput = this.now()
    this.cursor = { x: this.cursor.x + 50, y: this.cursor.y + 50 }
  }

  /** The clock of the readings: real time plus what advance() added. */
  now(): number {
    return 1_000_000 + (Date.now() - this.t0) + this.offset
  }

  /** Time passes (ms) without anyone touching the computer. */
  advance(ms: number): void {
    this.offset += ms
  }

  private inject(kind: FakeInput['kind'], detail: string): void {
    this.lastInput = this.now()
    this.lastInject = this.lastInput
    const i = { kind, detail }
    this.inputs.push(i)
    this.script?.(i, this)
  }

  private describe(w: WindowInfo | undefined): WindowInfo | undefined {
    return w ? { ...w, foreground: w.hwnd === this.fg } : undefined
  }

  async start(): Promise<void> {
    this.started++
  }
  dispose(): void {}
  async windows(): Promise<WindowInfo[]> {
    return this.wins.map((w) => this.describe(w)!)
  }
  async foreground(): Promise<WindowInfo | undefined> {
    return this.describe(this.wins.find((w) => w.hwnd === this.fg))
  }
  async window(hwnd: number): Promise<WindowInfo | undefined> {
    return this.describe(this.wins.find((w) => w.hwnd === hwnd))
  }
  async focus(hwnd: number): Promise<WindowInfo | undefined> {
    if (this.wins.some((w) => w.hwnd === hwnd)) {
      this.fg = hwnd
      this.inputs.push({ kind: 'focus', detail: String(hwnd) })
    }
    return this.window(hwnd)
  }
  async capture(hwnd: number): Promise<Capture> {
    const w = this.wins.find((x) => x.hwnd === hwnd)
    if (!w) throw new Error('janela fechada')
    return {
      png: FAKE_PNG,
      width: w.rect.width,
      height: w.rect.height,
      scale: 1,
      rect: w.rect,
      masked: [],
      window: this.describe(w)!
    }
  }
  async elements(hwnd: number): Promise<UiElement[]> {
    return this.elementsOf.get(hwnd) ?? []
  }
  async focused(): Promise<FocusedInfo | undefined> {
    return this.focusedField
  }
  async hit(x: number, y: number): Promise<WindowInfo | undefined> {
    const w = this.wins.find((w) => w.hwnd === this.fg) ?? this.wins[0]
    return w && x >= w.rect.x && y >= w.rect.y && x < w.rect.x + w.rect.width && y < w.rect.y + w.rect.height
      ? this.describe(w)
      : undefined
  }
  async click(x: number, y: number, opts: { button?: 'left' | 'right'; double?: boolean }): Promise<void> {
    this.cursor = { x, y }
    this.inject('click', `${x},${y}${opts.double ? ' double' : ''}${opts.button === 'right' ? ' right' : ''}`)
  }
  async type(text: string): Promise<void> {
    this.inject('type', text)
  }
  async key(key: string, modifiers: string[]): Promise<void> {
    this.inject('key', [...modifiers, key].join('+'))
  }
  async scroll(x: number, y: number, direction: string, amount: number): Promise<void> {
    this.cursor = { x, y }
    this.inject('scroll', `${direction} ${amount}`)
  }
  async release(): Promise<void> {
    this.inputs.push({ kind: 'release', detail: '' })
  }
  async idle(): Promise<IdleReading> {
    return {
      now: this.now(),
      lastInput: this.lastInput,
      lastInjectEnd: this.lastInject,
      cursor: { ...this.cursor },
      locked: this.locked
    }
  }
  /** The person does something while a task is recorded (ignored when nothing is being recorded). */
  did(e: Omit<WatchEvent, 't'>): void {
    if (!this.watching) return
    const outside = e.process !== undefined && !this.watching.processes.includes(e.process)
    this.watched.push(
      outside ? { t: Date.now() - this.watchT0, kind: e.kind, outside: true } : { ...e, t: Date.now() - this.watchT0 }
    )
  }
  async watchStart(opts: WatchOptions): Promise<void> {
    if (!opts.processes.length) throw new Error('diga quais apps observar')
    this.watching = opts
    this.watched = []
    this.watchT0 = Date.now()
  }
  async watchPoll(): Promise<WatchEvent[]> {
    const out = this.watched
    this.watched = []
    return out
  }
  async watchStop(): Promise<WatchEvent[]> {
    this.watching = undefined
    return this.watchPoll()
  }
  async launch(target: string): Promise<void> {
    this.inputs.push({ kind: 'launch', detail: target })
    const w = this.launches.get(target)
    if (w && !this.wins.some((x) => x.hwnd === w.hwnd)) {
      this.wins.push(w)
      this.fg = w.hwnd
    }
  }
}
