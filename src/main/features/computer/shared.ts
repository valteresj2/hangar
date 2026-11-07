// This computer lent to the platform's Digital employees (plan: docs/platform/computer-shared-workstations-plan.md).
// The employee runs on the platform; when it borrows this computer, its desktop_* steps arrive here already cleared by
// its authority, and this loop runs them on the screen with the local rules (allowed apps, window, keys, pause while
// the person uses the computer, secrets only into password fields) and sends back the screen. The person answers the
// loan requests (ask mode) and can stop a loan at any time. Long-poll over HTTPS, outbound only.
import type { AllowedApp, ComputerAction, LeaseInfo } from '../../../shared/features/computer'
import { HangarError, str } from './agui'
import type { ComputerDriver, Rect, WindowInfo } from './driver/types'
import { comboRefusal, normalizeCombo } from './guard'
import type { Presence } from './presence'
import { Screen } from './screen'

const SETTLE_MS = 450

export interface Step {
  id: number
  command: 'open' | 'look' | 'click' | 'type_text' | 'key' | 'scroll'
  args: Record<string, unknown>
}

export interface Beat {
  workstation: { id: number; name: string; online: boolean }
  requests: LeaseInfo[]
  active: LeaseInfo | null
  step: Step | null
}

/** What a step returns (the platform's governed desktop shape): the screen after it, or an error. */
export type StepResult =
  | {
      ok: boolean
      detail?: string
      window: string
      app: string
      size: [number, number]
      elements: string[]
      dica?: string
      screenshot: string
    }
  | { error: string }

type FetchLike = typeof fetch

/** The computer's client (token wst_…): only this computer's loans and steps. */
export class WorkstationClient {
  constructor(
    readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async req<T>(path: string, body: object, timeoutMs = 40_000, cancel?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const r = await this.fetchImpl(this.base.replace(/\/$/, '') + path, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
    })
    if (!r.ok) {
      let msg = r.statusText
      try {
        const j = (await r.json()) as { detail?: string }
        msg = j.detail ?? msg
      } catch {
        /* not JSON */
      }
      throw new HangarError(msg || `HTTP ${r.status}`, r.status)
    }
    return (await r.json()) as T
  }

  /** cancel: aborts the long-poll at once (Stop and "Parar de compartilhar" do not wait for it). */
  heartbeat(info: Record<string, unknown>, waitS: number, cancel?: AbortSignal): Promise<Beat> {
    return this.req('/hooks/workstation/heartbeat', { info, wait_s: waitS }, 40_000, cancel)
  }
  result(stepId: number, result: StepResult): Promise<unknown> {
    return this.req(`/hooks/workstation/steps/${stepId}/result`, { result })
  }
  answer(leaseId: number, allow: boolean, reason = ''): Promise<unknown> {
    return this.req(`/hooks/workstation/leases/${leaseId}/answer`, { allow, reason })
  }
  stop(leaseId: number): Promise<unknown> {
    return this.req(`/hooks/workstation/leases/${leaseId}/stop`, {})
  }
}

export interface SharedEvents {
  /** The loan in use (or none) and the requests waiting for the person. */
  state(s: { active: LeaseInfo | null; requests: LeaseInfo[]; paused: boolean; detail?: string }): void
  action(a: ComputerAction): void
  target(rect: Rect | undefined): void
  /** Asks the person (ask mode); resolves true to lend. The panel can answer too (answer()). */
  prompt(req: LeaseInfo): void
  revoked(): void
  error(detail: string): void
}

export interface SharedDeps {
  client: Pick<WorkstationClient, 'heartbeat' | 'result' | 'answer' | 'stop'>
  driver: ComputerDriver
  apps(): AllowedApp[]
  selfPid: number
  ignoreHwnds(): number[]
  presence: Presence
  info(): Record<string, string>
  events: SharedEvents
  sleep?(ms: number): Promise<void>
  waitS?: number
}

class Stopped extends Error {}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class SharedMachine {
  private stopped = false
  private readonly cancel = new AbortController()
  private prompted = new Set<number>()
  private pending = 0
  private active: LeaseInfo | null = null
  private requests: LeaseInfo[] = []
  private paused = false
  private loopDone?: Promise<void>
  private readonly screen: Screen
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly d: SharedDeps) {
    this.sleep = d.sleep ?? realSleep
    this.screen = new Screen({
      driver: d.driver,
      apps: d.apps,
      selfPid: d.selfPid,
      ignoreHwnds: d.ignoreHwnds,
      presence: d.presence,
      target: (rect) => d.events.target(rect),
      sleep: (ms) => this.sleep(ms),
      check: () => {
        if (this.stopped) throw new Stopped('parado pela pessoa')
      },
      onPause: (paused) => {
        this.paused = paused
        this.emit()
      }
    })
  }

  private emit(detail?: string): void {
    this.d.events.state({ active: this.active, requests: this.requests, paused: this.paused, detail })
  }

  start(): Promise<void> {
    this.loopDone = this.loop()
    return this.loopDone
  }

  /** Answers a loan request (from the prompt or the panel). */
  async answer(leaseId: number, allow: boolean): Promise<void> {
    await this.d.client.answer(leaseId, allow)
    this.requests = this.requests.filter((r) => r.lease_id !== leaseId)
    this.emit()
  }

  /** Stop: the loan in use ends now, every key and button goes up, and the computer stops serving until turned on. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.cancel.abort() // the long-poll in flight ends now
    this.d.events.target(undefined)
    const lease = this.active
    try {
      this.d.driver.dispose()
      await this.d.driver.start()
      await this.d.driver.release()
    } catch {
      /* nothing is being typed anyway */
    }
    if (lease) await this.d.client.stop(lease.lease_id).catch(() => undefined)
    this.active = null
    await this.loopDone?.catch(() => undefined)
  }

  private async loop(): Promise<void> {
    let first = true
    while (!this.stopped) {
      let beat: Beat
      try {
        // the first beat answers at once (the panel leaves "Conectando…"); the next ones long-poll
        const wait = first ? 0 : (this.d.waitS ?? 20)
        first = false
        beat = await this.d.client.heartbeat(
          { ...this.d.info(), seen_requests: this.pending },
          wait,
          this.cancel.signal
        )
      } catch (e) {
        if (this.stopped) return
        if (e instanceof HangarError && e.status === 401) {
          this.d.events.revoked()
          return
        }
        this.d.events.error(`Sem contato com a plataforma: ${(e as Error).message}`)
        await this.sleep(10_000)
        continue
      }
      if (this.stopped) return
      this.requests = beat.requests
      this.pending = beat.requests.length
      for (const r of beat.requests)
        if (!this.prompted.has(r.lease_id)) {
          this.prompted.add(r.lease_id)
          this.d.events.prompt(r)
        }
      const changed = (beat.active?.lease_id ?? 0) !== (this.active?.lease_id ?? 0)
      this.active = beat.active
      if (changed && !beat.active) {
        this.d.events.target(undefined)
        this.screen.reset()
      }
      this.emit()
      if (beat.step) {
        let res: StepResult
        try {
          res = await this.exec(beat.step)
        } catch (e) {
          if (e instanceof Stopped || this.stopped) return
          res = { error: (e as Error).message }
        }
        await this.d.client.result(beat.step.id, res).catch(() => undefined)
        if (this.active)
          this.d.events.action({
            at: Date.now(),
            taskId: this.active.task_id,
            tool: `desktop_${beat.step.command === 'type_text' ? 'type' : beat.step.command}`,
            summary: summary(beat.step),
            ok: !('error' in res) && res.ok !== false
          })
      }
    }
  }

  private async screenResult(w: WindowInfo, detail: string, ok = true): Promise<StepResult> {
    const v = await this.screen.view(w)
    const app = this.screen.allowed(v.cap.window)?.name ?? v.cap.window.process
    return {
      ok,
      detail,
      window: v.cap.window.title,
      app,
      size: [v.cap.width, v.cap.height],
      elements: v.lines,
      ...(v.lines.length ? {} : { dica: 'sem elementos de acessibilidade: clique por x,y na captura' }),
      screenshot: v.image
    }
  }

  private async stale(w: WindowInfo): Promise<StepResult> {
    return this.screenResult(
      w,
      'NÃO EXECUTEI: a pessoa usou o computador depois da sua última olhada. A tela abaixo é a de agora: confira e ' +
        'repita a ação se ainda fizer sentido.',
      false
    )
  }

  /** The window after an action, as a result. */
  private async after(w: WindowInfo, done: string): Promise<StepResult> {
    const { win, note } = await this.screen.after(w, SETTLE_MS)
    return this.screenResult(win, `${done}${note}`)
  }

  /** The capture the model's coordinates refer to: its last look at this window, or a fresh one. */
  private async capFor(w: WindowInfo) {
    const c = this.screen.cap
    return c && c.window.hwnd === w.hwnd ? c : (await this.screen.view(w)).cap
  }

  async exec(step: Step): Promise<StepResult> {
    const a = step.args ?? {}
    switch (step.command) {
      case 'open': {
        const app = this.screen.findApp(str(a.app))
        if (!app)
          return {
            error: `o app '${str(a.app)}' não está liberado neste computador (${this.d
              .apps()
              .map((x) => x.name)
              .join(', ')})`
          }
        await this.screen.ready()
        const w = await this.screen.openApp(app)
        if (typeof w === 'string') return { error: w }
        return this.screenResult(w, `${app.name} aberto`)
      }
      case 'look':
        return this.screenResult(await this.screen.target(str(a.window) || undefined), 'tela atual')
      case 'click': {
        const p = this.screen.point(a)
        if (!p) return { error: 'diga onde clicar (element ou x,y da última captura)' }
        const w = await this.screen.target()
        if ((await this.screen.ready()) === 'stale') return this.stale(w)
        const sp = await this.screen.aim(await this.capFor(w), p)
        await this.d.driver.click(sp.x, sp.y, { button: a.button === 'right' ? 'right' : 'left', double: !!a.double })
        this.d.presence.movedTo(sp.x, sp.y)
        return this.after(w, `cliquei em ${p.x},${p.y}`)
      }
      case 'type_text': {
        const p = this.screen.point(a)
        const w = await this.screen.target()
        if ((await this.screen.ready()) === 'stale') return this.stale(w)
        if (p) {
          const sp = await this.screen.aim(await this.capFor(w), p)
          await this.d.driver.click(sp.x, sp.y, {})
          this.d.presence.movedTo(sp.x, sp.y)
          await this.sleep(120)
        }
        if (a.secret === true) {
          const f = await this.d.driver.focused()
          const fw = f ? await this.d.driver.foreground() : undefined
          if (!f?.password || !this.screen.allowed(fw))
            return {
              error: 'NÃO DIGITEI: um segredo só é digitado num campo de senha (indique o campo com element ou x,y)'
            }
        }
        await this.d.driver.type(str(a.text))
        return this.after(w, a.secret === true ? 'digitei [segredo]' : 'digitei')
      }
      case 'key': {
        const key = str(a.key)
        const mods = Array.isArray(a.modifiers) ? a.modifiers.map(str) : []
        const no = comboRefusal(key, mods)
        if (no) return { error: `NÃO APERTEI: ${no}` }
        const c = normalizeCombo(key, mods)
        const w = await this.screen.target()
        if ((await this.screen.ready()) === 'stale') return this.stale(w)
        await this.d.driver.key(c.key, c.modifiers)
        return this.after(w, `apertei ${c.combo}`)
      }
      case 'scroll': {
        const w = await this.screen.target()
        if ((await this.screen.ready()) === 'stale') return this.stale(w)
        const cap = await this.capFor(w)
        const sp = await this.screen.aim(cap, { x: Math.floor(cap.width / 2), y: Math.floor(cap.height / 2) })
        const dir = ['up', 'down', 'left', 'right'].includes(str(a.direction)) ? str(a.direction) : 'down'
        await this.d.driver.scroll(sp.x, sp.y, dir, Math.max(1, Math.min(Number(a.amount ?? 3) || 3, 20)))
        this.d.presence.movedTo(sp.x, sp.y)
        return this.after(w, `rolei ${dir}`)
      }
      default:
        return { error: `comando desconhecido: ${str(step.command)}` }
    }
  }
}

function summary(step: Step): string {
  const a = step.args ?? {}
  switch (step.command) {
    case 'open':
      return str(a.app)
    case 'type_text':
      return a.secret === true ? '[segredo]' : str(a.text).slice(0, 60)
    case 'key':
      return [...(Array.isArray(a.modifiers) ? a.modifiers.map(str) : []), str(a.key)].join('+')
    case 'click':
      return a.element !== undefined ? `elemento ${str(a.element)}` : `${str(a.x)},${str(a.y)}`
    default:
      return str(a.direction) || ''
  }
}
