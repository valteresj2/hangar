// The screen side of the computer workstation, shared by its two modes — this computer as one employee's worker
// (worker.ts) and this computer lent to the platform's employees (shared.ts): which window to act on (only allowed
// apps), the capture with numbered elements, a point checked before clicking, waiting while the person uses the
// computer, and opening an allowed app. Electron-free; the caller injects the driver and the indicator.
import type { AllowedApp } from '../../../shared/features/computer'
import { str } from './agui'
import type { Capture, ComputerDriver, Rect, UiElement, WindowInfo } from './driver/types'
import { allowedAppOf, inside, toImage, toScreen, windowRefusal } from './guard'
import type { Presence } from './presence'

export const MAX_WIDTH = 1366

export interface ScreenDeps {
  driver: ComputerDriver
  apps(): AllowedApp[]
  selfPid: number
  ignoreHwnds(): number[]
  presence: Presence
  /** The window being worked on (the indicator's border), or undefined. */
  target(rect: Rect | undefined): void
  sleep(ms: number): Promise<void>
  /** Throws when the person pressed Stop. */
  check(): void
  /** Called when waiting for the person starts (true) and ends (false). */
  onPause(paused: boolean): void
}

export interface View {
  text: string
  image: string
  cap: Capture
  /** The element lines of the text ("[0] button "Salvar" @750,30"). */
  lines: string[]
}

export class Screen {
  hwnd?: number
  app?: string
  cap?: Capture
  elements: { el: UiElement; x: number; y: number }[] = []
  lookTick = 0
  private paused = false

  constructor(private readonly d: ScreenDeps) {}

  reset(): void {
    this.cap = undefined
    this.elements = []
  }

  allowed(w: WindowInfo | undefined): AllowedApp | undefined {
    return allowedAppOf(w, this.d.apps(), { selfPid: this.d.selfPid })
  }

  private allowedPids(all: WindowInfo[], w: WindowInfo): number[] {
    return [...new Set([w.pid, ...all.filter((x) => this.allowed(x)).map((x) => x.pid)])]
  }

  /** The window to act on: the foreground one if it is allowed, else the one in use (brought to the front). */
  async target(want?: string): Promise<WindowInfo> {
    this.d.check()
    const apps = this.d.apps()
    const fg = await this.d.driver.foreground()
    const matches = (w: WindowInfo): boolean => !want || w.title.toLowerCase().includes(want.toLowerCase())
    if (fg && this.allowed(fg) && matches(fg)) {
      this.hwnd = fg.hwnd
      return fg
    }
    const open = (await this.d.driver.windows()).filter((w) => this.allowed(w))
    const pick =
      (want ? open.find(matches) : undefined) ??
      open.find((w) => w.hwnd === this.hwnd) ??
      (this.app ? open.find((w) => allowedAppOf(w, apps)?.name === this.app) : undefined) ??
      (want ? undefined : open[0])
    if (!pick) {
      const why = want
        ? `nenhuma janela de app liberado com "${want}" no título`
        : windowRefusal(fg, apps, this.d.selfPid)
      throw new Error(`${why}. Abra um app liberado com desktop_open.`)
    }
    await this.d.driver.focus(pick.hwnd)
    const now = await this.d.driver.foreground()
    if (!now || !this.allowed(now)) throw new Error(`não consegui trazer "${pick.title}" para a frente`)
    this.hwnd = now.hwnd
    return now
  }

  /** Captures the window and lists its elements (numbered, in image coordinates). */
  async view(w: WindowInfo): Promise<View> {
    const all = await this.d.driver.windows()
    const cap = await this.d.driver.capture(w.hwnd, {
      maxWidth: MAX_WIDTH,
      allowedPids: this.allowedPids(all, w),
      ignoreHwnds: this.d.ignoreHwnds()
    })
    const els = await this.d.driver.elements(w.hwnd, 120).catch(() => [] as UiElement[])
    this.cap = cap
    this.elements = []
    for (const el of els) {
      const cx = el.x + el.width / 2
      const cy = el.y + el.height / 2
      if (!inside(cap.rect, cx, cy)) continue
      this.elements.push({ el, ...toImage(cap, cx, cy) })
    }
    this.d.target(cap.rect)
    const idle = await this.d.driver.idle().catch(() => undefined)
    if (idle) {
      this.d.presence.observe(idle)
      this.lookTick = idle.now
    }
    const allowed = allowedAppOf(cap.window, this.d.apps())
    if (allowed) this.app = allowed.name
    const app = allowed?.name ?? cap.window.process
    const lines = this.elements.map(({ el, x, y }, n) => {
      const v = el.password ? ' [campo de senha]' : el.value ? ` = "${el.value}"` : ''
      return `[${n}] ${el.type} "${el.name}"${v} @${x},${y}`
    })
    const text =
      `Janela: "${cap.window.title}" (${app}) · captura ${cap.width}x${cap.height} px (x,y são pixels desta captura)` +
      (cap.masked.length ? `\n${cap.masked.length} área(s) em preto: janelas de apps não liberados por cima.` : '') +
      (lines.length
        ? `\nElementos:\n${lines.join('\n')}`
        : '\nSem elementos de acessibilidade: clique por x,y na captura.')
    return { text, image: cap.png, cap, lines }
  }

  /** Waits while the person uses the computer. 'stale': they did, after the model's last look. */
  async ready(): Promise<'ok' | 'stale'> {
    for (;;) {
      this.d.check()
      const st = this.d.presence.observe(await this.d.driver.idle())
      if (st === 'free') break
      if (!this.paused) {
        this.paused = true
        this.d.onPause(true)
      }
      await this.d.sleep(400)
    }
    if (this.paused) {
      this.paused = false
      this.d.onPause(false)
    }
    return this.d.presence.staleSince(this.lookTick) ? 'stale' : 'ok'
  }

  /** A point of the last capture (or an element number) → image coordinates; undefined when none was given. */
  point(i: Record<string, unknown>): { x: number; y: number } | undefined {
    if (i.element !== undefined && i.element !== null && i.element !== '') {
      const n = Number(str(i.element).replace(/\D/g, ''))
      const e = this.elements[n]
      if (!e) throw new Error(`não há elemento [${str(i.element)}] na última captura: olhe de novo (desktop_look)`)
      return { x: e.x, y: e.y }
    }
    if (typeof i.x === 'number' && typeof i.y === 'number') return { x: i.x, y: i.y }
    return undefined
  }

  /** Screen point of image coordinates, checked: inside the window, on a window of an allowed app. */
  async aim(cap: Capture, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
    if (p.x < 0 || p.y < 0 || p.x >= cap.width || p.y >= cap.height)
      throw new Error(`o ponto ${p.x},${p.y} está fora da captura (${cap.width}x${cap.height})`)
    const sp = toScreen(cap, p.x, p.y)
    if (!inside(cap.rect, sp.x, sp.y)) throw new Error('o ponto está fora da janela do app')
    const under = await this.d.driver.hit(sp.x, sp.y, this.d.ignoreHwnds())
    if (!this.allowed(under))
      throw new Error(`no ponto ${p.x},${p.y} há outra janela (${windowRefusal(under, this.d.apps(), this.d.selfPid)})`)
    return sp
  }

  /** The allowed app named by the model (exact name or process, or a part of the name). */
  findApp(name: string): AllowedApp | undefined {
    const apps = this.d.apps()
    const q = name.trim().toLowerCase()
    return (
      apps.find((a) => a.name.toLowerCase() === q || a.process.toLowerCase() === q) ??
      apps.find((a) => a.name.toLowerCase().includes(q) && q.length >= 3)
    )
  }

  /** Brings an allowed app to the front, starting it when it is closed. Returns its window, or why it could not. */
  async openApp(app: AllowedApp): Promise<WindowInfo | string> {
    const mine = (w: WindowInfo): boolean => allowedAppOf(w, [app], { selfPid: this.d.selfPid }) !== undefined
    let w = (await this.d.driver.windows()).find(mine)
    if (!w) {
      if (!app.launch) return `não sei como abrir "${app.name}" (sem atalho): peça à pessoa para abri-lo.`
      await this.d.driver.launch(app.launch)
      for (let n = 0; n < 40 && !w; n++) {
        this.d.check()
        await this.d.sleep(500)
        w = (await this.d.driver.windows()).find(mine)
      }
      if (!w) return `"${app.name}" não abriu uma janela em 20 s.`
    }
    await this.d.driver.focus(w.hwnd)
    this.hwnd = w.hwnd
    this.app = app.name
    const fg = (await this.d.driver.foreground()) ?? w
    return mine(fg) ? fg : w
  }

  /** The window after an action (the allowed one in front, or the same) and a note when a non-allowed app came up. */
  async after(w: WindowInfo, settleMs: number): Promise<{ win: WindowInfo; note: string }> {
    await this.d.sleep(settleMs)
    const fg = await this.d.driver.foreground()
    if (fg && this.allowed(fg)) return { win: fg, note: '' }
    return {
      win: w,
      note: fg
        ? `\nAtenção: agora está na frente "${fg.title}", que não é um app liberado; continuo só nos liberados.`
        : ''
    }
  }
}
