// The workstation loop: this computer works as the external worker of one Digital employee (the same shape as the VS
// Code workstation): heartbeat → AG-UI rounds with the employee's brain → the desktop_* tools run here → result. Before
// any input: the window must belong to an allowed app (guard.ts), the person must not be using the computer
// (presence.ts) and the platform's authority must allow it (POST /gate "desktop:<action>", with the screenshot when the
// action may confirm something). Secrets are typed only into password fields and never kept. Electron-free: the
// controller injects the driver, the client and the indicator.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AllowedApp, ComputerAction } from '../../../shared/features/computer'
import {
  compact,
  decisionResult,
  HangarError,
  imagesMessage,
  str,
  toAguiMessages,
  toolOk,
  type AguiMessage,
  type GateResult,
  type WorkerClient,
  type WorkerTask
} from './agui'
import type { Capture, ComputerDriver, Rect, UiElement, WindowInfo } from './driver/types'
import { comboRefusal, normalizeCombo } from './guard'
import type { Presence } from './presence'
import { Screen, type View } from './screen'
import { COMPUTER_TOOL_NAMES, COMPUTER_TOOLS, summarize } from './tools'

const MAX_ROUNDS = 200
const SETTLE_MS = 450
const IMAGES_PER_ROUND = 2

interface Call {
  id: string
  name: string
  input: Record<string, unknown>
  raw: string
}

/** What a task keeps on disk between runs (never a secret's value, never more than the latest captures). */
export interface TaskState {
  messages: AguiMessage[]
  pending: Call[]
  waiting?: { callId: string; request?: number }
  serverSeen?: number
  /** Captures of the current round, added after its tool results (OpenAI wants tool results right after the call). */
  images?: string[]
  /** The numbered elements of the last screen the model saw: a call that comes back after a decision still points at them. */
  elements?: { el: UiElement; x: number; y: number }[]
}

export interface WorkerStatus {
  status: 'idle' | 'working' | 'paused' | 'stopped' | 'error'
  task?: { id: number; title: string }
  detail?: string
}

export interface WorkerEvents {
  status(s: WorkerStatus): void
  action(a: ComputerAction): void
  /** The window the employee is working in (screen pixels), or undefined when it is not acting. */
  target(rect: Rect | undefined): void
  revoked(): void
}

export interface WorkerDeps {
  client: Pick<WorkerClient, 'heartbeat' | 'gate' | 'progress' | 'result' | 'agui'>
  driver: ComputerDriver
  stateDir: string
  apps(): AllowedApp[]
  selfPid: number
  ignoreHwnds(): number[]
  info(): Record<string, string>
  presence: Presence
  events: WorkerEvents
  sleep?(ms: number): Promise<void>
}

class StopError extends Error {
  constructor() {
    super('parado pela pessoa')
  }
}

/** A tool result: text for the model and, usually, the capture after the action. */
interface Out {
  text: string
  image?: string
  /** The gate stopped the task until someone decides. */
  waiting?: { request?: number }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class Worker {
  private stopped = false
  private abort = new AbortController()
  private taskId?: number
  private taskTitle = ''
  private readonly screen: Screen
  private monitor?: NodeJS.Timeout
  private paused = false
  private loopDone?: Promise<void>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly d: WorkerDeps) {
    this.sleep = d.sleep ?? realSleep
    this.screen = new Screen({
      driver: d.driver,
      apps: d.apps,
      selfPid: d.selfPid,
      ignoreHwnds: d.ignoreHwnds,
      presence: d.presence,
      target: (rect) => d.events.target(rect),
      sleep: (ms) => this.sleep(ms),
      check: () => this.check(),
      onPause: (paused) => {
        this.paused = paused
        this.d.events.status(
          paused
            ? { status: 'paused', task: this.task(), detail: this.pausedDetail() }
            : { status: 'working', task: this.task(), detail: 'Trabalhando' }
        )
      }
    })
  }

  start(): Promise<void> {
    this.loopDone = this.loop()
    return this.loopDone
  }

  /** The kill switch: no further action; the current one is cut short; the task goes back to the platform. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    this.d.events.target(undefined)
    try {
      this.d.driver.dispose() // cuts an action in progress (a long typing) at once
      await this.d.driver.start()
      await this.d.driver.release()
    } catch {
      /* the helper may not be able to start again: nothing is being typed anyway */
    }
    await this.loopDone?.catch(() => undefined)
  }

  // ------------------------------------------------------------------ loop
  private async loop(): Promise<void> {
    await this.resumeOrphans()
    while (!this.stopped) {
      try {
        const hb = await this.d.client.heartbeat(this.d.info())
        if (this.stopped) return
        if (hb.task) {
          await this.work(hb.task)
          continue
        }
        this.d.events.status({ status: 'idle', detail: `Aguardando tarefas (${hb.status})` })
        await this.sleepUnlessStopped((hb.next_heartbeat_s || 10) * 1000)
      } catch (e) {
        if (this.stopped) return
        if (e instanceof HangarError && e.status === 401) {
          this.d.events.status({ status: 'error', detail: 'O token do posto não vale mais (revogado em outro lugar).' })
          this.d.events.revoked()
          return
        }
        this.d.events.status({ status: 'error', detail: `Sem contato com a plataforma: ${(e as Error).message}` })
        await this.sleepUnlessStopped(15_000)
      }
    }
  }

  private async sleepUnlessStopped(ms: number): Promise<void> {
    const end = Date.now() + ms
    while (!this.stopped && Date.now() < end) await this.sleep(Math.min(500, end - Date.now()))
  }

  private stateFile(id: number): string {
    return join(this.d.stateDir, `task-${id}.json`)
  }
  load(id: number): TaskState | undefined {
    try {
      return JSON.parse(readFileSync(this.stateFile(id), 'utf8')) as TaskState
    } catch {
      return undefined
    }
  }
  private save(id: number, s: TaskState): void {
    mkdirSync(this.d.stateDir, { recursive: true })
    writeFileSync(this.stateFile(id), JSON.stringify({ ...s, elements: this.screen.elements }))
  }

  /** The app closed in the middle of a task: hand it back so the heartbeat brings it again (the conversation stays here). */
  private async resumeOrphans(): Promise<void> {
    if (!existsSync(this.d.stateDir)) return
    for (const n of readdirSync(this.d.stateDir)) {
      const id = Number(/^task-(\d+)\.json$/.exec(n)?.[1])
      if (!id) continue
      await this.d.client.result(id, 'waiting').catch(() => undefined)
    }
  }

  private context(task: WorkerTask): { description: string; value: string }[] {
    const apps = this.d.apps()
    return [
      {
        description: 'Posto de trabalho',
        value:
          `Você está operando a tela do computador da pessoa (Windows), pelo app Agent Hangar Desktop. Apps liberados ` +
          `neste computador: ${apps.map((a) => a.name).join(', ') || 'nenhum'}; nenhum outro funciona e as teclas do ` +
          'Windows (Win, Alt+Tab) são bloqueadas. Use desktop_open para abrir um app liberado, desktop_look para ver a ' +
          'janela (a captura vem como imagem; x,y são pixels dessa captura; os elementos têm número para clicar) e ' +
          'desktop_click/desktop_type/desktop_key/desktop_scroll para agir, conferindo a tela depois de cada ação. ' +
          'Clicar, digitar Enter ou apertar atalhos que salvam, confirmam, enviam ou pagam passa pela sua alçada (a ' +
          'pessoa vê a captura). Senhas: text="secret://nome", só num campo de senha. A pessoa vê um aviso de que você ' +
          'está usando o computador e pode pausar (usando o mouse/teclado) ou parar você a qualquer momento: se a tela ' +
          'mudou, olhe de novo antes de agir. As ferramentas da plataforma (update_plan, ask_human, handoff_task…) ' +
          'continuam valendo.'
      },
      { description: 'Tarefa', value: `#${task.id} ${task.title} — ${task.url}` }
    ]
  }

  private startMonitor(): void {
    this.stopMonitor()
    this.monitor = setInterval(() => {
      void this.d.driver
        .idle()
        .then((r) => {
          const st = this.d.presence.observe(r)
          const paused = st !== 'free'
          if (paused !== this.paused && this.taskId !== undefined && !this.stopped) {
            this.paused = paused
            this.d.events.status(
              paused
                ? { status: 'paused', task: this.task(), detail: this.pausedDetail() }
                : { status: 'working', task: this.task(), detail: 'Trabalhando' }
            )
          }
        })
        .catch(() => undefined)
    }, 500)
    this.monitor.unref?.()
  }

  private stopMonitor(): void {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
  }

  private task(): { id: number; title: string } | undefined {
    return this.taskId === undefined ? undefined : { id: this.taskId, title: this.taskTitle }
  }

  private pausedDetail(): string {
    const p = this.d.presence
    if (p.state === 'locked') return 'Pausado: a tela está bloqueada.'
    return `Pausado: você está usando o computador. Retomo ${p.waitS() ? `em ${p.waitS()} s` : 'já'} sem uso.`
  }

  private async work(task: WorkerTask): Promise<void> {
    const saved = this.load(task.id)
    const s: TaskState = saved ?? {
      messages: toAguiMessages(task.messages),
      pending: [],
      serverSeen: task.messages.length
    }
    const arrived = saved
      ? task.messages.slice(saved.serverSeen ?? task.messages.length).filter((m) => m.role === 'user')
      : []
    s.serverSeen = task.messages.length
    this.taskId = task.id
    this.taskTitle = task.title
    this.screen.elements = saved?.elements ?? []
    this.paused = false
    this.d.events.status({ status: 'working', task: this.task(), detail: `Tarefa #${task.id} (vez ${task.run})` })
    this.startMonitor()
    const keepalive = setInterval(() => {
      void this.d.client.progress(task.id).catch(() => undefined)
      void this.d.client.heartbeat(this.d.info(), false).catch(() => undefined)
    }, 60_000)
    keepalive.unref?.()
    try {
      const handled = s.waiting?.request
      if (s.pending.length && (await this.runCalls(task, s, arrived)) === 'waiting') return
      const said = new Set(s.messages.map((m) => (typeof m.content === 'string' ? m.content : '')))
      for (const m of arrived) {
        if (handled !== undefined && m.content.startsWith(`DECISÃO #${handled}:`)) continue
        if (!said.has(m.content))
          s.messages.push({ id: `u-${Date.now()}-${s.messages.length}`, role: 'user', content: m.content })
      }
      this.save(task.id, s)
      for (let round = 1; round <= MAX_ROUNDS && !this.stopped; round++) {
        let text = ''
        let state: { status: string } | undefined
        const calls: Call[] = []
        const body = {
          threadId: `task-${task.id}`,
          runId: `r-${Date.now()}`,
          messages: compact(s.messages),
          tools: COMPUTER_TOOLS,
          context: this.context(task)
        }
        for await (const ev of this.d.client.agui(task.id, body, COMPUTER_TOOL_NAMES, this.abort.signal)) {
          if (ev.type === 'text') text += ev.text
          else if (ev.type === 'client_call') calls.push(ev)
          else if (ev.type === 'task') state = ev.value
          else if (ev.type === 'error') throw new Error(ev.message)
        }
        if (this.stopped) throw new StopError()
        s.messages.push({
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: text,
          ...(calls.length
            ? {
                toolCalls: calls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.raw }
                }))
              }
            : {})
        })
        s.pending = calls
        this.save(task.id, s)
        if (state?.status === 'waiting_human') return // a platform tool stopped at the authority
        if (!calls.length) {
          const r = await this.d.client.result(task.id, 'done', text.trim() || '(sem texto final)')
          if (r.status === 'new') {
            this.save(task.id, s)
            return
          }
          rmSync(this.stateFile(task.id), { force: true })
          return
        }
        if ((await this.runCalls(task, s)) === 'waiting') return
      }
      if (!this.stopped) await this.d.client.result(task.id, 'waiting')
    } catch (e) {
      if (this.stopped || e instanceof StopError) {
        await this.d.client
          .progress(task.id, 'Parado pela pessoa no computador (botão Parar do posto).')
          .catch(() => undefined)
        await this.d.client.result(task.id, 'waiting').catch(() => undefined)
        return
      }
      const msg = (e as Error).message
      if (e instanceof HangarError && e.status === 409) {
        if (/orçamento|budget/i.test(msg)) await this.d.client.result(task.id, 'failed', '', msg).catch(() => undefined)
        return
      }
      this.d.events.status({ status: 'error', task: this.task(), detail: `A rodada parou: ${msg}` })
      await this.d.client.result(task.id, 'waiting').catch(() => undefined)
      await this.sleepUnlessStopped(10_000)
    } finally {
      clearInterval(keepalive)
      this.stopMonitor()
      this.d.events.target(undefined)
      this.taskId = undefined
      this.screen.reset()
    }
  }

  /** Runs the pending calls. 'waiting': the task left this workstation until someone decides. */
  private async runCalls(
    task: WorkerTask,
    s: TaskState,
    arrived: { content: string }[] = []
  ): Promise<'ok' | 'waiting'> {
    s.images ??= []
    for (const call of s.pending) {
      if (s.messages.some((m) => m.role === 'tool' && m.toolCallId === call.id)) continue
      if (this.stopped) throw new StopError()
      const t0 = Date.now()
      const decided =
        s.waiting?.callId === call.id ? task.decisions.find((x) => x.id === s.waiting?.request) : undefined
      const refused = decisionResult(decided, arrived)
      let out: Out
      if (refused !== undefined) out = { text: refused }
      else {
        try {
          out = await this.exec(task.id, call)
        } catch (e) {
          if (e instanceof StopError || this.stopped) throw new StopError()
          out = { text: `erro: ${(e as Error).message}` }
        }
      }
      if (out.waiting) {
        s.waiting = { callId: call.id, request: out.waiting.request }
        this.save(task.id, s)
        this.d.events.status({
          status: 'idle',
          task: this.task(),
          detail: `Aguardando uma decisão: ${call.name} ${summarize(call.name, call.input)}`
        })
        return 'waiting'
      }
      s.waiting = undefined
      const ok = toolOk(out.text)
      const summary = summarize(call.name, call.input)
      const ms = Date.now() - t0
      void this.d.client.progress(task.id, '', { tool: { name: call.name, summary, ok, ms } }).catch(() => undefined)
      this.record({ at: Date.now(), taskId: task.id, tool: call.name, summary, ok }, ms)
      s.messages.push({ id: `t-${call.id}`, role: 'tool', toolCallId: call.id, content: out.text })
      if (out.image) s.images = [...s.images, out.image].slice(-IMAGES_PER_ROUND)
      this.save(task.id, s)
    }
    if (s.images.length) s.messages.push(imagesMessage(`img-${Date.now()}`, s.images))
    s.images = []
    s.pending = []
    this.save(task.id, s)
    return 'ok'
  }

  /** Local audit: what was done on this screen (no screenshots, no secrets). */
  private record(a: ComputerAction, ms: number): void {
    this.d.events.action(a)
    try {
      mkdirSync(this.d.stateDir, { recursive: true })
      appendFileSync(join(this.d.stateDir, 'audit.jsonl'), `${JSON.stringify({ ...a, ms })}\n`)
    } catch {
      /* the audit is best effort; the platform's timeline is the record */
    }
  }

  // ------------------------------------------------------------------ tools
  private exec(taskId: number, call: Call): Promise<Out> {
    const i = call.input
    switch (call.name) {
      case 'desktop_open':
        return this.open(taskId, str(i.app))
      case 'desktop_look':
        return this.look(str(i.window) || undefined)
      case 'desktop_click':
        return this.click(taskId, i)
      case 'desktop_type':
        return this.type(taskId, i)
      case 'desktop_key':
        return this.key(taskId, str(i.key), Array.isArray(i.modifiers) ? i.modifiers.map(str) : [], !!i.commit)
      case 'desktop_scroll':
        return this.scroll(i)
      case 'desktop_screenshot':
        return this.screenshot(taskId)
      default:
        return Promise.resolve({ text: `erro: ferramenta desconhecida: ${call.name}` })
    }
  }

  private check(): void {
    if (this.stopped) throw new StopError()
  }

  private target(want?: string): Promise<WindowInfo> {
    return this.screen.target(want)
  }

  private view(w: WindowInfo): Promise<View> {
    return this.screen.view(w)
  }

  /** Waits while the person uses the computer. 'stale': they did, after the model's last look. */
  private ready(): Promise<'ok' | 'stale'> {
    return this.screen.ready()
  }

  private async staleView(w: WindowInfo): Promise<Out> {
    const v = await this.view(w)
    return {
      text:
        'NÃO EXECUTEI: a pessoa usou o computador depois da sua última olhada. A tela abaixo é a de agora: confira e ' +
        `repita a ação se ainda fizer sentido.\n${v.text}`,
      image: v.image
    }
  }

  private held(g: GateResult): Out | undefined {
    if (g.status === 'allowed') return undefined
    if (g.status === 'waiting') return { text: '', waiting: { request: g.request_id } }
    if (g.status === 'simulated') return { text: '(modo sombra) ação simulada, não executada.' }
    const m = g.message ?? ''
    return {
      text: m.startsWith('NÃO ') ? m : `NEGADO pela alçada: ${m}. Não tente contornar; siga sem essa ação ou explique.`
    }
  }

  /** After an action: the new screen, and the window after it for the platform's retry rule. */
  private async after(taskId: number, event: number | undefined, w: WindowInfo, done: string): Promise<Out> {
    const { win, note } = await this.screen.after(w, SETTLE_MS)
    const v = await this.view(win)
    if (event)
      void this.d.client.progress(taskId, '', { desktop: { event, after: v.cap.window.title } }).catch(() => undefined)
    return { text: `${done}${note}\n${v.text}`, image: v.image }
  }

  private point(i: Record<string, unknown>): { x: number; y: number } | undefined {
    return this.screen.point(i)
  }

  private aim(cap: Capture, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
    return this.screen.aim(cap, p)
  }

  private async look(want?: string): Promise<Out> {
    const w = await this.target(want)
    const v = await this.view(w)
    return { text: v.text, image: v.image }
  }

  private async open(taskId: number, name: string): Promise<Out> {
    this.check()
    const app = this.screen.findApp(name)
    if (!app)
      return {
        text: `erro: o app "${name}" não está liberado neste computador. Liberados: ${
          this.d
            .apps()
            .map((a) => a.name)
            .join(', ') || 'nenhum'
        }.`
      }
    const g = await this.d.client.gate(taskId, 'desktop:open', { app: app.name, window: '' })
    const h = this.held(g)
    if (h) return h
    await this.ready() // opening needs no fresh look: its result is a fresh look anyway
    const w = await this.screen.openApp(app)
    if (typeof w === 'string') return { text: `erro: ${w}` }
    const v = await this.view(w)
    if (g.event)
      void this.d.client
        .progress(taskId, '', { desktop: { event: g.event, after: v.cap.window.title } })
        .catch(() => undefined)
    return { text: `ok: ${app.name} aberto.\n${v.text}`, image: v.image }
  }

  private async click(taskId: number, i: Record<string, unknown>): Promise<Out> {
    const label = str(i.label)
    const p = this.point(i)
    if (!p) return { text: 'erro: diga onde clicar (element ou x,y da última captura)' }
    const w = await this.target()
    if ((await this.ready()) === 'stale') return this.staleView(w)
    const before = await this.view(w)
    await this.aim(before.cap, p)
    const g = await this.d.client.gate(
      taskId,
      'desktop:click',
      { label, x: p.x, y: p.y, window: w.title, commit: !!i.commit, repeat: !!i.repeat },
      '',
      before.image
    )
    const h = this.held(g)
    if (h) return h
    const where =
      g.where && typeof g.where.x === 'number' && typeof g.where.y === 'number' ? { x: g.where.x, y: g.where.y } : p
    this.check()
    const sp = await this.aim(before.cap, where)
    const fg = await this.d.driver.foreground()
    if (!fg || fg.hwnd !== w.hwnd) await this.d.driver.focus(w.hwnd)
    await this.d.driver.click(sp.x, sp.y, { button: i.button === 'right' ? 'right' : 'left', double: !!i.double })
    this.d.presence.movedTo(sp.x, sp.y)
    return this.after(
      taskId,
      g.event,
      w,
      `ok: cliquei em "${label}" (${where.x},${where.y})${g.approved ? ` — aprovado (#${g.approved})` : ''}.`
    )
  }

  private async type(taskId: number, i: Record<string, unknown>): Promise<Out> {
    const text = str(i.text)
    const label = str(i.label)
    const secret = text.startsWith('secret://')
    const p = this.point(i)
    const w = await this.target()
    if ((await this.ready()) === 'stale') return this.staleView(w)
    const enter = /[\r\n]/.test(text)
    const before = enter || p ? await this.view(w) : undefined
    if (p && before) await this.aim(before.cap, p)
    const g = await this.d.client.gate(
      taskId,
      'desktop:type',
      { text, label, window: w.title, ...(p ?? {}) },
      '',
      enter && before ? before.image : ''
    )
    const h = this.held(g)
    if (h) return h
    this.check()
    if (p && before) {
      const sp = await this.aim(before.cap, p)
      await this.d.driver.click(sp.x, sp.y, {})
      this.d.presence.movedTo(sp.x, sp.y)
      await this.sleep(120)
    }
    if (secret || g.secret) {
      const f = await this.d.driver.focused()
      const fw = f ? await this.d.driver.foreground() : undefined
      if (!f?.password || !this.screen.allowed(fw)) {
        if (g.event)
          void this.d.client
            .progress(taskId, '', { desktop: { event: g.event, ok: false, error: 'não é um campo de senha' } })
            .catch(() => undefined)
        return {
          text: 'NÃO DIGITEI: um segredo só é digitado num campo de senha (clique no campo de senha antes, com element ou x,y).'
        }
      }
    }
    // The real text (a secret's value) lives only in this call: never in the conversation, the state or the log.
    await this.d.driver.type(g.text ?? text)
    const shown = secret ? '[segredo]' : text.length > 60 ? `${text.slice(0, 60)}…` : text
    return this.after(taskId, g.event, w, `ok: digitei ${label ? `em "${label}": ` : ''}${shown}`)
  }

  private async key(taskId: number, key: string, modifiers: string[], commit: boolean): Promise<Out> {
    if (!key.trim()) return { text: 'erro: diga a tecla (key)' }
    const no = comboRefusal(key, modifiers)
    if (no) return { text: `NÃO APERTEI: ${no}.` }
    const c = normalizeCombo(key, modifiers)
    const w = await this.target()
    if ((await this.ready()) === 'stale') return this.staleView(w)
    const before = await this.view(w)
    const g = await this.d.client.gate(
      taskId,
      'desktop:key',
      { key: c.key, modifiers: c.modifiers, commit, window: w.title },
      '',
      before.image
    )
    const h = this.held(g)
    if (h) return h
    this.check()
    const fg = await this.d.driver.foreground()
    if (!fg || fg.hwnd !== w.hwnd) await this.d.driver.focus(w.hwnd)
    await this.d.driver.key(c.key, c.modifiers)
    return this.after(taskId, g.event, w, `ok: apertei ${c.combo}${g.approved ? ` — aprovado (#${g.approved})` : ''}.`)
  }

  private async scroll(i: Record<string, unknown>): Promise<Out> {
    const w = await this.target()
    if ((await this.ready()) === 'stale') return this.staleView(w)
    const before = await this.view(w)
    const p = this.point(i) ?? { x: Math.floor(before.cap.width / 2), y: Math.floor(before.cap.height / 2) }
    const sp = await this.aim(before.cap, p)
    const dir = ['up', 'down', 'left', 'right'].includes(str(i.direction)) ? str(i.direction) : 'down'
    await this.d.driver.scroll(sp.x, sp.y, dir, Math.max(1, Math.min(Number(i.amount ?? 3) || 3, 20)))
    this.d.presence.movedTo(sp.x, sp.y)
    await this.sleep(250)
    const v = await this.view(w)
    return { text: `ok: rolei ${dir}.\n${v.text}`, image: v.image }
  }

  private async screenshot(taskId: number): Promise<Out> {
    const w = await this.target()
    const v = await this.view(w)
    const g = await this.d.client.gate(taskId, 'desktop:screenshot', { window: w.title }, '', v.image)
    const h = this.held(g)
    if (h) return h
    return { text: `Captura salva na tarefa: ${g.file ?? ''}` }
  }
}
