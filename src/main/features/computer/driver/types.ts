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
}
