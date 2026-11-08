// What the workstation needs from the operating system. Windows: windows.ts (a C# helper over Win32 and UI Automation).
// Tests and the e2e: fake.ts. macOS/Linux drivers would implement the same interface (see the plan, section 3.1).
// Coordinates are physical screen pixels.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowInfo {
  hwnd: number
  title: string
  className: string
  pid: number
  /** Process of the window that owns it (a dialog's owner); equals pid for a main window. */
  ownerPid: number
  /** Full executable path ('' when Windows refuses to tell: an elevated process). */
  exe: string
  /** Executable name without extension ('' when unknown). */
  process: string
  elevated: boolean
  rect: Rect
  minimized: boolean
  foreground: boolean
}

export interface Capture {
  /** PNG, base64. */
  png: string
  width: number
  height: number
  /** image pixels = screen pixels × scale. */
  scale: number
  rect: Rect
  /** Areas painted black because a window of a non-allowed app was above the target. */
  masked: Rect[]
  window: WindowInfo
}

export interface UiElement {
  name: string
  type: string
  password: boolean
  x: number
  y: number
  width: number
  height: number
  value: string
}

export interface FocusedInfo {
  name: string
  type: string
  password: boolean
  pid: number
}

/** GetLastInputInfo and our own last injection, in the same clock (ms ticks). */
export interface IdleReading {
  now: number
  lastInput: number
  lastInjectEnd: number
  cursor: { x: number; y: number }
  locked: boolean
}

/** What the person did while a task was being recorded (the helper's watch mode). */
export interface WatchEvent {
  /** ms since the watch started. */
  t: number
  kind: 'click' | 'type' | 'key' | 'window'
  /** In an app that is not being recorded: nothing else is reported. */
  outside?: boolean
  button?: 'left' | 'right'
  x?: number
  y?: number
  window?: string
  process?: string
  element?: { name: string; type: string; password?: boolean }
  /** click: PNG (base64) of the window at that moment, other apps blacked out. */
  frame?: string
  rect?: Rect
  scale?: number
  field?: string
  fieldType?: string
  /** type: the field's final value (never for a password field). */
  value?: string
  password?: boolean
  key?: string
  modifiers?: string[]
}

export interface WatchOptions {
  /** Process names (without extension) of the apps being recorded. */
  processes: string[]
  maxWidth: number
  /** Our own windows (the recording indicator): clicks on them are not recorded. */
  ignoreHwnds: number[]
  /** Tests only (they click with SendInput): also record injected input. The app never sets it. */
  acceptInjected?: boolean
}

export interface ComputerDriver {
  readonly name: string
  start(): Promise<void>
  dispose(): void
  windows(): Promise<WindowInfo[]>
  foreground(): Promise<WindowInfo | undefined>
  window(hwnd: number): Promise<WindowInfo | undefined>
  focus(hwnd: number): Promise<WindowInfo | undefined>
  /** The window's rectangle as on screen; windows of processes outside allowedPids (and above it) are blacked out. */
  capture(hwnd: number, opts: { maxWidth: number; allowedPids: number[]; ignoreHwnds: number[] }): Promise<Capture>
  elements(hwnd: number, max: number): Promise<UiElement[]>
  focused(): Promise<FocusedInfo | undefined>
  /** The top-level window under a screen point (ignore: the indicator windows, which are not really in the way). */
  hit(x: number, y: number, ignore?: number[]): Promise<WindowInfo | undefined>
  click(x: number, y: number, opts: { button?: 'left' | 'right'; double?: boolean }): Promise<void>
  type(text: string): Promise<void>
  key(key: string, modifiers: string[]): Promise<void>
  scroll(x: number, y: number, direction: string, amount: number): Promise<void>
  /** Every modifier and mouse button up (the kill switch). */
  release(): Promise<void>
  idle(): Promise<IdleReading>
  /** Starts an allowed app (the executable or shortcut the person picked). */
  launch(target: string): Promise<void>
  /** Recording a task (only drivers that support it; Windows for now). */
  watchStart?(opts: WatchOptions): Promise<void>
  watchPoll?(): Promise<WatchEvent[]>
  watchStop?(): Promise<WatchEvent[]>
}
