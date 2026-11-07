// Linux driver (X11, and XWayland apps under Wayland): standard tools instead of a compiled helper —
//   xprop / xdotool    windows, stacking order, focus, mouse and keyboard (XTest)
//   import (ImageMagick) the window's rectangle as on screen, other apps above it painted black, scaled down
//   xprintidle         the person's last input (presence)
//   python3 + AT-SPI   numbered elements and "is the focused field a password?" (optional: without it the model
//                      clicks by x,y and secrets are refused)
// Text is typed with `xdotool type --file -` (stdin), so a secret never shows in a process list. Coordinates are
// screen pixels. Packages (Debian/Ubuntu): xdotool x11-utils imagemagick xprintidle python3-gi gir1.2-atspi-2.0.
import { execFile, spawn } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import type { Capture, ComputerDriver, FocusedInfo, IdleReading, Rect, UiElement, WindowInfo } from './types'

export interface ExecResult {
  code: number
  stdout: Buffer
  stderr: string
}
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number; env?: Record<string, string> }
) => Promise<ExecResult>

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 15_000,
        env: { ...process.env, ...opts.env }
      },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString('utf8') })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })

/** Our key names → X keysyms. */
const KEYSYMS: Record<string, string> = {
  return: 'Return',
  enter: 'Return',
  kp_enter: 'KP_Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  page_up: 'Prior',
  prior: 'Prior',
  pagedown: 'Next',
  page_down: 'Next',
  next: 'Next',
  left: 'Left',
  up: 'Up',
  right: 'Right',
  down: 'Down',
  space: 'space',
  menu: 'Menu',
  ctrl: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  super: 'super'
}

export function keysym(name: string): string {
  const l = name.toLowerCase()
  if (KEYSYMS[l]) return KEYSYMS[l]
  if (/^f\d{1,2}$/.test(l)) return l.toUpperCase()
  if (name.length === 1) return name
  return name
}

/** "window id # 0x1a00003, 0x2200007" → ids, bottom to top. */
export function parseStacking(out: string): number[] {
  const m = /#\s*(.*)$/m.exec(out)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n > 0)
}

/** The properties of one window from `xprop -id … _NET_WM_PID _NET_WM_NAME WM_CLASS _NET_WM_WINDOW_TYPE _NET_WM_STATE`. */
export function parseXprop(out: string): {
  pid: number
  title: string
  wmClass: string
  type: string
  hidden: boolean
} {
  const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(out)?.[1] ?? 0)
  const quoted = (re: RegExp): string | undefined => re.exec(out)?.[1]?.replace(/\\(.)/g, '$1')
  const title =
    quoted(/_NET_WM_NAME\(UTF8_STRING\) = "((?:[^"\\]|\\.)*)"/) ??
    quoted(/^WM_NAME\(\w+\) = "((?:[^"\\]|\\.)*)"/m) ??
    ''
  const cls = /WM_CLASS\(STRING\) = "([^"]*)", "([^"]*)"/.exec(out)
  const type = /_NET_WM_WINDOW_TYPE\(ATOM\) = _NET_WM_WINDOW_TYPE_(\w+)/.exec(out)?.[1]?.toLowerCase() ?? 'normal'
  const hidden = /_NET_WM_STATE\(ATOM\) = .*_NET_WM_STATE_HIDDEN/.test(out)
  return { pid, title, wmClass: cls?.[2] ?? '', type, hidden }
}

/** `xwininfo -id …` → the client area in screen pixels ("Absolute upper-left X/Y", "Width", "Height"). xdotool's
 *  getwindowgeometry is off by the frame for windows a window manager reparented, so it is not used. */
export function parseGeometry(out: string): Rect {
  const v = (k: string): number => Number(new RegExp(`^\\s*${k}:\\s*(-?\\d+)`, 'm').exec(out)?.[1] ?? 0)
  return { x: v('Absolute upper-left X'), y: v('Absolute upper-left Y'), width: v('Width'), height: v('Height') }
}

const intersect = (a: Rect, b: Rect): Rect | undefined => {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined
}

/** Lists the accessible elements of a process's window, or the focused element (AT-SPI over D-Bus). */
export const ATSPI_SCRIPT = String.raw`
import json, sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
mode, pid = sys.argv[1], int(sys.argv[2] or 0)
gx, gy, gw, gh, limit = (int(v) for v in sys.argv[3:8])
INTERACTIVE = {'push button': 'button', 'toggle button': 'button', 'text': 'edit', 'password text': 'edit',
  'entry': 'edit', 'check box': 'check box', 'radio button': 'radio button', 'combo box': 'combo box',
  'menu item': 'menu item', 'list item': 'list item', 'page tab': 'tab item', 'link': 'link',
  'table cell': 'data item', 'tree item': 'tree item', 'spin button': 'spinner', 'slider': 'slider',
  'document text': 'document', 'menu': 'menu item'}
def ext(a):
  e = a.get_extents(Atspi.CoordType.SCREEN)
  return e.x, e.y, e.width, e.height
def is_password(a):
  return a.get_role_name() == 'password text'
def value(a):
  if is_password(a): return ''
  try:
    t = a.get_text_iface()
    if t: return (t.get_text(0, min(t.get_character_count(), 80)) or '')
  except Exception: pass
  return ''
desk = Atspi.get_desktop(0)
out = []
if mode == 'focused':
  for i in range(desk.get_child_count()):
    app = desk.get_child_at_index(i)
    if app is None: continue
    stack = [app]
    while stack:
      a = stack.pop()
      try:
        if a.get_state_set().contains(Atspi.StateType.FOCUSED) and a.get_role_name() != 'frame':
          print(json.dumps({'name': a.get_name() or '', 'type': a.get_role_name(), 'password': is_password(a), 'pid': app.get_process_id()}))
          sys.exit(0)
        for j in range(min(a.get_child_count(), 300)): stack.append(a.get_child_at_index(j))
      except Exception: pass
  print('null'); sys.exit(0)
for i in range(desk.get_child_count()):
  app = desk.get_child_at_index(i)
  if app is None or app.get_process_id() != pid: continue
  best, dist = None, 1e9
  for j in range(app.get_child_count()):
    w = app.get_child_at_index(j)
    try:
      x, y, wd, ht = ext(w)
      d = abs(x - gx) + abs(y - gy) + abs(wd - gw) + abs(ht - gh)
      if d < dist: best, dist = w, d
    except Exception: pass
  queue = [best] if best else []
  seen = 0
  while queue and len(out) < limit and seen < 4000:
    a = queue.pop(0); seen += 1
    try:
      role = a.get_role_name()
      st = a.get_state_set()
      if role in INTERACTIVE and st.contains(Atspi.StateType.SHOWING) and st.contains(Atspi.StateType.ENABLED):
        x, y, wd, ht = ext(a)
        if wd > 1 and ht > 1:
          out.append({'name': (a.get_name() or '').strip(), 'type': INTERACTIVE[role], 'password': is_password(a),
                      'x': x, 'y': y, 'width': wd, 'height': ht, 'value': value(a)})
      for j in range(min(a.get_child_count(), 500)): queue.append(a.get_child_at_index(j))
    except Exception: pass
  break
print(json.dumps(out))
`

export class LinuxDriver implements ComputerDriver {
  readonly name = 'linux'
  /** Shown in the panel when something limits the workstation (Wayland, no AT-SPI…). */
  notice?: string
  private lastInjectEnd = 0
  private hasAtspi = false
  private importCmd: string[] = ['import']

  constructor(
    private readonly exec: Exec = realExec,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private async run(cmd: string, args: string[], input?: string): Promise<string> {
    const r = await this.exec(cmd, args, { input })
    if (r.code !== 0) throw new Error(`${cmd} ${args[0] ?? ''}: ${r.stderr.trim() || `saída ${r.code}`}`)
    return r.stdout.toString('utf8')
  }

  private async has(cmd: string): Promise<boolean> {
    return (await this.exec('sh', ['-c', `command -v ${cmd}`])).code === 0
  }

  async start(): Promise<void> {
    if (!this.env.DISPLAY)
      throw new Error(
        this.env.WAYLAND_DISPLAY
          ? 'Sessão Wayland sem XWayland: o posto no computador precisa de uma sessão X11 (ou XWayland ativo).'
          : 'Sem tela gráfica (DISPLAY): o posto no computador precisa de uma sessão X11.'
      )
    const missing: string[] = []
    for (const [cmd, pkg] of [
      ['xdotool', 'xdotool'],
      ['xprop', 'x11-utils'],
      ['xprintidle', 'xprintidle']
    ])
      if (!(await this.has(cmd))) missing.push(pkg)
    if (await this.has('import')) this.importCmd = ['import']
    else if (await this.has('magick')) this.importCmd = ['magick', 'import']
    else missing.push('imagemagick')
    if (missing.length)
      throw new Error(
        `Faltam programas para o posto no computador: instale ${missing.join(' ')} (ex.: sudo apt install ${missing.join(' ')}).`
      )
    this.hasAtspi = (await this.exec('python3', ['-c', 'import gi; gi.require_version("Atspi", "2.0")'])).code === 0
    const notes: string[] = []
    if (this.env.XDG_SESSION_TYPE === 'wayland')
      notes.push('Sessão Wayland: só apps que rodam no XWayland (X11) aparecem e podem ser operados.')
    if (!this.hasAtspi)
      notes.push('Sem AT-SPI (python3-gi, gir1.2-atspi-2.0): sem elementos numerados e sem digitar segredos.')
    this.notice = notes.join(' ') || undefined
  }

  dispose(): void {}

  private async stacking(): Promise<number[]> {
    return parseStacking(await this.run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']))
  }

  private async describe(id: number, active?: number): Promise<WindowInfo | undefined> {
    const props = await this.exec('xprop', [
      '-id',
      String(id),
      '_NET_WM_PID',
      '_NET_WM_NAME',
      'WM_NAME',
      'WM_CLASS',
      '_NET_WM_WINDOW_TYPE',
      '_NET_WM_STATE'
    ])
    if (props.code !== 0) return undefined
    const p = parseXprop(props.stdout.toString('utf8'))
    const geo = await this.exec('xwininfo', ['-id', String(id)])
    if (geo.code !== 0) return undefined
    let exe = ''
    let proc = ''
    if (p.pid) {
      try {
        exe = readlinkSync(`/proc/${p.pid}/exe`)
        proc = basename(exe)
      } catch {
        try {
          proc = readFileSync(`/proc/${p.pid}/comm`, 'utf8').trim()
        } catch {
          /* gone */
        }
      }
    }
    const shell = ['dock', 'desktop'].includes(p.type)
    return {
      hwnd: id,
      title: p.title,
      className: shell ? p.type : p.wmClass,
      pid: p.pid,
      ownerPid: p.pid,
      exe,
      process: proc,
      // a process of another user (root) whose executable we cannot read
      elevated: !!p.pid && !exe && !!proc,
      rect: parseGeometry(geo.stdout.toString('utf8')),
      minimized: p.hidden,
      foreground: active === id
    }
  }

  private async active(): Promise<number | undefined> {
    const r = await this.exec('xdotool', ['getactivewindow'])
    const id = Number(r.stdout.toString('utf8').trim())
    return r.code === 0 && id > 0 ? id : undefined
  }

  async windows(): Promise<WindowInfo[]> {
    const ids = await this.stacking()
    const active = await this.active()
    const out: WindowInfo[] = []
    for (const id of ids.reverse()) {
      const w = await this.describe(id, active)
      if (w && !w.minimized && w.rect.width > 1 && w.rect.height > 1) out.push(w)
    }
    return out // top to bottom
  }

  async foreground(): Promise<WindowInfo | undefined> {
    const id = await this.active()
    return id ? this.describe(id, id) : undefined
  }

  async window(hwnd: number): Promise<WindowInfo | undefined> {
    return this.describe(hwnd, await this.active())
  }

  async focus(hwnd: number): Promise<WindowInfo | undefined> {
    await this.exec('xdotool', ['windowactivate', '--sync', String(hwnd)], { timeoutMs: 3000 })
    return this.window(hwnd)
  }

  async capture(
    hwnd: number,
    opts: { maxWidth: number; allowedPids: number[]; ignoreHwnds: number[] }
  ): Promise<Capture> {
    const w = await this.window(hwnd)
    if (!w) throw new Error('janela fechada')
    const r = w.rect
    const ids = await this.stacking()
    const above = ids.slice(ids.indexOf(hwnd) + 1)
    const masked: Rect[] = []
    for (const id of above) {
      if (opts.ignoreHwnds.includes(id)) continue
      const o = await this.describe(id)
      // the indicator windows are in ignoreHwnds; Hangar's own main window, like any other app, is blacked out
      if (!o || o.minimized || opts.allowedPids.includes(o.pid)) continue
      const i = intersect(r, o.rect)
      if (i) masked.push(i)
    }
    const scale = r.width > opts.maxWidth ? opts.maxWidth / r.width : 1
    const sw = Math.max(1, Math.round(r.width * scale))
    const sh = Math.max(1, Math.round(r.height * scale))
    const args = [
      ...this.importCmd.slice(1),
      '-silent',
      '-window',
      'root',
      '-crop',
      `${r.width}x${r.height}+${r.x}+${r.y}`,
      '+repage'
    ]
    if (masked.length) {
      args.push('-fill', 'black')
      for (const m of masked)
        args.push('-draw', `rectangle ${m.x - r.x},${m.y - r.y} ${m.x - r.x + m.width - 1},${m.y - r.y + m.height - 1}`)
    }
    if (scale < 1) args.push('-resize', `${sw}x${sh}!`)
    args.push('png:-')
    const res = await this.exec(this.importCmd[0], args, { timeoutMs: 20_000 })
    if (res.code !== 0 || !res.stdout.length) throw new Error(`captura falhou: ${res.stderr.trim()}`)
    return { png: res.stdout.toString('base64'), width: sw, height: sh, scale, rect: r, masked, window: w }
  }

  private async atspi(args: string[]): Promise<unknown> {
    if (!this.hasAtspi) return undefined
    const r = await this.exec('python3', ['-c', ATSPI_SCRIPT, ...args], { timeoutMs: 4000 })
    if (r.code !== 0) return undefined
    try {
      return JSON.parse(r.stdout.toString('utf8'))
    } catch {
      return undefined
    }
  }

  async elements(hwnd: number, max: number): Promise<UiElement[]> {
    const w = await this.window(hwnd)
    if (!w) return []
    const r = w.rect
    const out = await this.atspi([
      'list',
      String(w.pid),
      String(r.x),
      String(r.y),
      String(r.width),
      String(r.height),
      String(max)
    ])
    return Array.isArray(out) ? (out as UiElement[]) : []
  }

  async focused(): Promise<FocusedInfo | undefined> {
    const out = await this.atspi(['focused', '0', '0', '0', '0', '0', '0'])
    return out && typeof out === 'object' ? (out as FocusedInfo) : undefined
  }

  async hit(x: number, y: number, ignore: number[] = []): Promise<WindowInfo | undefined> {
    for (const w of await this.windows()) {
      if (ignore.includes(w.hwnd)) continue
      const r = w.rect
      if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height) return w
    }
    return undefined
  }

  private done(): void {
    this.lastInjectEnd = Date.now()
  }

  async click(x: number, y: number, opts: { button?: 'left' | 'right'; double?: boolean }): Promise<void> {
    const btn = opts.button === 'right' ? '3' : '1'
    await this.run('xdotool', [
      'mousemove',
      '--sync',
      String(Math.round(x)),
      String(Math.round(y)),
      'click',
      ...(opts.double ? ['--repeat', '2', '--delay', '80'] : []),
      btn
    ])
    this.done()
  }

  async type(text: string): Promise<void> {
    await this.run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--file', '-'], text)
    this.done()
  }

  async key(key: string, modifiers: string[]): Promise<void> {
    await this.run('xdotool', ['key', '--clearmodifiers', [...modifiers.map(keysym), keysym(key)].join('+')])
    this.done()
  }

  async scroll(x: number, y: number, direction: string, amount: number): Promise<void> {
    const btn = { up: '4', down: '5', left: '6', right: '7' }[direction] ?? '5'
    const n = Math.max(1, Math.min(amount, 20))
    await this.run('xdotool', [
      'mousemove',
      '--sync',
      String(Math.round(x)),
      String(Math.round(y)),
      'click',
      '--repeat',
      String(n),
      btn
    ])
    this.done()
  }

  async release(): Promise<void> {
    await this.exec('xdotool', [
      'keyup',
      'ctrl',
      'shift',
      'alt',
      'super',
      'Control_L',
      'Control_R',
      'Shift_L',
      'Shift_R',
      'Alt_L',
      'Alt_R',
      'Super_L',
      'Super_R'
    ])
    for (const b of ['1', '2', '3']) await this.exec('xdotool', ['mouseup', b])
    this.done()
  }

  async idle(): Promise<IdleReading> {
    const now = Date.now()
    const idleMs = Number((await this.exec('xprintidle', [])).stdout.toString('utf8').trim()) || 0
    const loc = (await this.exec('xdotool', ['getmouselocation', '--shell'])).stdout.toString('utf8')
    let locked = false
    if (this.env.XDG_SESSION_ID) {
      const l = await this.exec('loginctl', ['show-session', this.env.XDG_SESSION_ID, '-p', 'LockedHint', '--value'])
      locked = l.code === 0 && l.stdout.toString('utf8').trim() === 'yes'
    }
    const v = (k: string): number => Number(new RegExp(`^${k}=(-?\\d+)`, 'm').exec(loc)?.[1] ?? 0)
    return { now, lastInput: now - idleMs, lastInjectEnd: this.lastInjectEnd, cursor: { x: v('X'), y: v('Y') }, locked }
  }

  /** An executable, or a .desktop entry (its Exec line, without the %f/%u field codes). */
  async launch(target: string): Promise<void> {
    let cmd = target
    if (target.endsWith('.desktop')) {
      const exec = /^Exec=(.*)$/m.exec(readFileSync(target, 'utf8'))?.[1]
      if (!exec) throw new Error(`o atalho ${basename(target)} não diz como abrir o app`)
      cmd = exec.replace(/%[a-zA-Z]/g, '').trim()
      spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore', env: this.env }).unref()
      return
    }
    spawn(cmd, [], { detached: true, stdio: 'ignore', env: this.env }).unref()
  }
}
