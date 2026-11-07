// Computer workstation (docs/platform/computer-workstation-plan.md): the guard (allowed apps, blocked apps and keys,
// coordinates), the presence (pause when the person uses the computer), the AG-UI pieces (client calls, screenshots
// as image messages, pruning) and the worker loop on a pretend computer: the gate before acting, waiting for a
// decision and coming back, the click where the person approved, secrets only into password fields and never kept,
// not acting blind after the person used the computer, and the kill switch.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllowedApp } from '../../src/shared/features/computer'
import {
  compact,
  decisionResult,
  IMAGE_MARKER,
  imagesMessage,
  parseAgui,
  pruneImages,
  type AguiEvent,
  type AguiMessage,
  type GateResult,
  type WorkerTask
} from '../../src/main/features/computer/agui'
import { FAKE_PNG, FakeDriver, fakeWindow } from '../../src/main/features/computer/driver/fake'
import {
  allowedAppOf,
  blockedReason,
  comboRefusal,
  toImage,
  toScreen,
  warningFor,
  windowRefusal
} from '../../src/main/features/computer/guard'
import { Presence } from '../../src/main/features/computer/presence'
import { COMPUTER_TOOL_NAMES, summarize } from '../../src/main/features/computer/tools'
import { Worker, type TaskState } from '../../src/main/features/computer/worker'

const NOTEPAD: AllowedApp = { name: 'Bloco de Notas', process: 'notepad', launch: 'C:\\Windows\\System32\\notepad.exe' }
const ERP: AllowedApp = { name: 'ERP Legado', process: 'erp' }

describe('guard', () => {
  const notes = fakeWindow({ hwnd: 7, title: 'nota.txt - Bloco de Notas', process: 'Notepad' })
  it('allows only the windows of allowed apps, never blocked ones, the shell or the app itself', () => {
    expect(allowedAppOf(notes, [NOTEPAD])?.name).toBe('Bloco de Notas')
    expect(allowedAppOf(notes, [ERP])).toBeUndefined()
    expect(allowedAppOf({ ...notes, process: 'taskmgr' }, [{ name: 'TM', process: 'taskmgr' }])).toBeUndefined()
    expect(allowedAppOf({ ...notes, className: 'Shell_TrayWnd' }, [NOTEPAD])).toBeUndefined()
    expect(allowedAppOf({ ...notes, elevated: true }, [NOTEPAD])).toBeUndefined()
    expect(allowedAppOf(notes, [NOTEPAD], { selfPid: notes.pid })).toBeUndefined()
    expect(blockedReason('Hangar.exe')).toMatch(/Agent Hangar/)
    expect(blockedReason('control')).toMatch(/Painel de Controle/)
    expect(warningFor('chrome')).toMatch(/navegador/)
    expect(windowRefusal({ ...notes, process: 'excel', title: 'Pasta1' }, [NOTEPAD])).toMatch(
      /não está entre os apps liberados/
    )
    expect(windowRefusal({ ...notes, elevated: true }, [NOTEPAD])).toMatch(/administrador/)
  })
  it('refuses Windows-level shortcuts and the kill switch', () => {
    expect(comboRefusal('r', ['win'])).toBeTruthy()
    expect(comboRefusal('Tab', ['alt'])).toMatch(/desktop_open/)
    expect(comboRefusal('Delete', ['ctrl', 'alt'])).toBeTruthy()
    expect(comboRefusal('Escape', ['ctrl', 'shift'])).toMatch(/Gerenciador/)
    expect(comboRefusal('End', ['control', 'alt'])).toMatch(/parar/)
    expect(comboRefusal('s', ['ctrl'])).toBeUndefined()
    expect(comboRefusal('Return', [])).toBeUndefined()
  })
  it('maps capture pixels to the screen and back', () => {
    const cap = { rect: { x: 200, y: 100, width: 2000, height: 1000 }, scale: 0.5 }
    expect(toScreen(cap, 100, 50)).toEqual({ x: 400, y: 200 })
    expect(toImage(cap, 400, 200)).toEqual({ x: 100, y: 50 })
  })
})

describe('presence', () => {
  const reading = (now: number, lastInput: number, lastInjectEnd: number, cursor = { x: 0, y: 0 }, locked = false) => ({
    now,
    lastInput,
    lastInjectEnd,
    cursor,
    locked
  })
  it('pauses on the person’s input and resumes after the quiet time', () => {
    const p = new Presence(10_000)
    expect(p.observe(reading(1000, 900, 900))).toBe('free') // our own injection
    expect(p.observe(reading(2000, 1900, 900))).toBe('paused') // input a second after ours: the person
    expect(p.waitS(2000)).toBe(10)
    expect(p.observe(reading(11_000, 1900, 900))).toBe('paused')
    expect(p.observe(reading(12_000, 1900, 900))).toBe('free')
    expect(p.staleSince(1500)).toBe(true) // the model looked before the person's input
    expect(p.staleSince(12_000)).toBe(false)
  })
  it('notices the cursor leaving where we put it, a locked screen and "Retomar agora"', () => {
    const p = new Presence(10_000)
    p.movedTo(100, 100)
    expect(p.observe(reading(1000, 500, 500, { x: 101, y: 100 }))).toBe('free')
    expect(p.observe(reading(1500, 500, 500, { x: 300, y: 100 }))).toBe('paused')
    p.override(1600)
    expect(p.observe(reading(1700, 500, 500, { x: 300, y: 100 }))).toBe('free')
    expect(p.observe(reading(1800, 500, 500, { x: 300, y: 100 }, true))).toBe('locked')
  })
})

describe('AG-UI', () => {
  async function* chunks(lines: object[]): AsyncGenerator<string> {
    for (const l of lines) yield `data: ${JSON.stringify(l)}\n\n`
  }
  it('yields our tool calls at the end and the platform’s as already run', async () => {
    const evs: AguiEvent[] = []
    for await (const e of parseAgui(
      chunks([
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'Vou olhar.' },
        { type: 'TOOL_CALL_START', toolCallId: 'p1', toolCallName: 'update_plan' },
        { type: 'TOOL_CALL_RESULT', toolCallId: 'p1', content: 'ok' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'desktop_look' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' }
      ]),
      COMPUTER_TOOL_NAMES
    ))
      evs.push(e)
    expect(evs.map((e) => e.type)).toEqual(['text', 'server_tool', 'client_call'])
  })
  it('sends captures as one user image message and keeps only the latest ones', () => {
    const m = imagesMessage('i1', [FAKE_PNG])
    expect(Array.isArray(m.content) && m.content[0].type === 'text' && m.content[0].text.startsWith(IMAGE_MARKER)).toBe(
      true
    )
    const msgs: AguiMessage[] = [1, 2, 3, 4, 5].map((n) => imagesMessage(`i${n}`, [FAKE_PNG]))
    const pruned = pruneImages(msgs, 3)
    expect(pruned.filter((x) => typeof x.content === 'string')).toHaveLength(2)
    expect(compact(msgs).filter((x) => Array.isArray(x.content))).toHaveLength(3)
  })
  it('turns a refused decision into the decider’s words', () => {
    expect(decisionResult({ id: 4, decision: 'approve' }, [])).toBeUndefined()
    expect(decisionResult({ id: 4, decision: 'reject' }, [{ content: 'DECISÃO #4: RECUSADO. Não salve.' }])).toMatch(
      /Não salve/
    )
  })
  it('never puts a secret in a summary', () => {
    expect(summarize('desktop_type', { text: 'secret://erp', label: 'Senha' })).toBe('Senha: [segredo]')
    expect(summarize('desktop_key', { key: 's', modifiers: ['ctrl'] })).toBe('ctrl+s')
  })
})

// ------------------------------------------------------------------ the worker on a pretend computer
type Round = (body: { messages: AguiMessage[] }) => object[]

class FakeClient {
  gates: { tool: string; args: Record<string, unknown>; screenshot: boolean }[] = []
  progress_: unknown[] = []
  results: { id: number; status: string; text: string }[] = []
  rounds: Round[] = []
  bodies: { messages: AguiMessage[] }[] = []
  gateFn: (tool: string, args: Record<string, unknown>) => GateResult = () => ({ status: 'allowed', event: 1 })

  async heartbeat(): Promise<{ employee: string; name: string; status: string; task: null; next_heartbeat_s: number }> {
    return { employee: 'ana', name: 'Ana', status: 'active', task: null, next_heartbeat_s: 1 }
  }
  async gate(_t: number, tool: string, args: object, _r = '', screenshot = ''): Promise<GateResult> {
    this.gates.push({ tool, args: args as Record<string, unknown>, screenshot: !!screenshot })
    return this.gateFn(tool, args as Record<string, unknown>)
  }
  async progress(
    _t: number,
    note = '',
    extra: object = {}
  ): Promise<{ status: string; cost_usd: number; stop: boolean }> {
    this.progress_.push({ note, ...extra })
    return { status: 'in_progress', cost_usd: 0, stop: false }
  }
  async result(id: number, status: 'done' | 'failed' | 'waiting', text = ''): Promise<{ status: string }> {
    this.results.push({ id, status, text })
    return { status }
  }
  async *agui(_id: number, body: object, names: ReadonlySet<string>): AsyncGenerator<AguiEvent> {
    const b = JSON.parse(JSON.stringify(body)) as { messages: AguiMessage[] }
    this.bodies.push(b)
    const round = this.rounds.shift()
    if (!round) throw new Error('rodada inesperada')
    async function* lines(ls: object[]): AsyncGenerator<string> {
      for (const l of ls) yield `data: ${JSON.stringify(l)}\n`
    }
    yield* parseAgui(lines(round(b)), names)
  }
}

const text = (m: AguiMessage | undefined): string =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')

const call = (id: string, name: string, args: object): object[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) }
]
const say = (text: string): object[] => [{ type: 'TEXT_MESSAGE_CONTENT', delta: text }]

const task = (over: Partial<WorkerTask> = {}): WorkerTask => ({
  id: 41,
  title: 'Nota da reunião',
  body: '',
  run: 1,
  url: 'http://p/app/#/tasks/41',
  messages: [{ role: 'user', content: 'Escreva a nota e salve.' }],
  decisions: [],
  budget_usd: 1,
  cost_usd: 0,
  time_limit_min: 30,
  ...over
})

describe('worker', () => {
  let dir: string
  let fake: FakeDriver
  let client: FakeClient
  let worker: Worker
  let presence: Presence
  const targets: unknown[] = []
  const work = (t: WorkerTask): Promise<void> => (worker as unknown as { work(t: WorkerTask): Promise<void> }).work(t)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-computer-'))
    const notes = fakeWindow({ hwnd: 7, title: 'Sem título - Bloco de Notas', process: 'notepad' })
    const other = fakeWindow({ hwnd: 9, title: 'Pasta1 - Excel', process: 'excel' })
    fake = new FakeDriver({ windows: [notes, other], foreground: 9 })
    fake.elementsOf.set(7, [
      { name: 'Salvar', type: 'button', password: false, x: 820, y: 120, width: 60, height: 20, value: '' },
      { name: 'Senha', type: 'edit', password: true, x: 300, y: 300, width: 200, height: 20, value: '' }
    ])
    client = new FakeClient()
    presence = new Presence(1000)
    worker = new Worker({
      client,
      driver: fake,
      stateDir: dir,
      apps: () => [NOTEPAD],
      selfPid: 1,
      ignoreHwnds: () => [],
      info: () => ({ name: 'Computador (teste)' }),
      presence,
      events: {
        status: () => undefined,
        action: () => undefined,
        target: (r) => targets.push(r),
        revoked: () => undefined
      },
      sleep: async (ms) => fake.advance(ms)
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('works in the allowed app, waits for the decision on Ctrl+S and presses it after the approval', async () => {
    client.rounds = [
      () => [...say('Vou olhar.'), ...call('c1', 'desktop_look', {})],
      () => call('c2', 'desktop_type', { text: 'Pauta: orçamento', label: 'Texto' }),
      () => call('c3', 'desktop_key', { key: 's', modifiers: ['ctrl'] })
    ]
    client.gateFn = (tool) =>
      tool === 'desktop:key' ? { status: 'waiting', request_id: 77 } : { status: 'allowed', event: 5 }
    await work(task())
    // the Excel window in front is not allowed: the worker brought the Notepad forward and never touched Excel
    expect(fake.inputs.find((i) => i.kind === 'focus')?.detail).toBe('7')
    expect(fake.inputs.filter((i) => i.kind === 'type').map((i) => i.detail)).toEqual(['Pauta: orçamento'])
    expect(fake.inputs.some((i) => i.kind === 'key')).toBe(false) // waiting for the decision
    expect(client.gates.map((g) => g.tool)).toEqual(['desktop:type', 'desktop:key'])
    expect(client.gates[1].screenshot).toBe(true) // the approval carries the screen
    const saved = JSON.parse(readFileSync(join(dir, 'task-41.json'), 'utf8')) as TaskState
    expect(saved.waiting).toEqual({ callId: 'c3', request: 77 })
    // the images went to the model as one message after the tool results, never inside them
    const second = client.bodies[1].messages
    const toolMsg = second.find((m) => m.role === 'tool')!
    expect(typeof toolMsg.content === 'string' && !toolMsg.content.includes(FAKE_PNG)).toBe(true)
    expect(second.at(-1)?.role).toBe('user')
    expect(JSON.stringify(second.at(-1)?.content)).toContain(FAKE_PNG)
    // approved: the task comes back, the same call runs, then the employee delivers
    client.gateFn = () => ({ status: 'allowed', event: 6, approved: 77 })
    client.rounds = [() => say('Nota salva.')]
    await work(
      task({
        run: 2,
        decisions: [{ id: 77, kind: 'approval', status: 'approved', decision: 'approve', tool: 'desktop_key' }]
      })
    )
    expect(fake.inputs.filter((i) => i.kind === 'key').map((i) => i.detail)).toEqual(['ctrl+s'])
    expect(client.results.at(-1)).toEqual({ id: 41, status: 'done', text: 'Nota salva.' })
    expect(readdirSync(dir).some((f) => f.startsWith('task-41'))).toBe(false)
    expect(client.progress_.some((p) => JSON.stringify(p).includes('"desktop":{"event":6'))).toBe(true)
  })

  it('clicks where the person approved, not a few pixels off', async () => {
    fake.fg = 7
    client.rounds = [
      () => call('c1', 'desktop_look', {}),
      () => call('c2', 'desktop_click', { label: 'Salvar', x: 733, y: 33 }),
      () => say('ok')
    ]
    client.gateFn = (tool) =>
      tool === 'desktop:click'
        ? { status: 'allowed', where: { x: 730, y: 30 }, approved: 9, event: 3 }
        : { status: 'allowed' }
    await work(task())
    expect(fake.inputs.find((i) => i.kind === 'click')?.detail).toBe('830,130') // window at 100,100, scale 1
    expect(client.gates[0].args).toMatchObject({
      label: 'Salvar',
      x: 733,
      y: 33,
      window: 'Sem título - Bloco de Notas'
    })
  })

  it('a click by element number still works when the task comes back after the decision', async () => {
    fake.fg = 7
    client.rounds = [
      () => call('c1', 'desktop_look', {}),
      () => call('c2', 'desktop_click', { label: 'Salvar', element: '0' })
    ]
    client.gateFn = () => ({ status: 'waiting', request_id: 5 })
    await work(task())
    expect(fake.inputs.some((i) => i.kind === 'click')).toBe(false)
    client.gateFn = () => ({ status: 'allowed', approved: 5, where: { x: 750, y: 30 }, event: 8 })
    client.rounds = [() => say('Salvo.')]
    await work(
      task({
        run: 2,
        decisions: [{ id: 5, kind: 'approval', status: 'approved', decision: 'approve', tool: 'desktop:click' }]
      })
    )
    expect(fake.inputs.find((i) => i.kind === 'click')?.detail).toBe('850,130')
    expect(client.results.at(-1)?.status).toBe('done')
  })

  it('types a secret only into a password field and keeps it nowhere', async () => {
    fake.fg = 7
    client.gateFn = (tool) =>
      tool === 'desktop:type'
        ? { status: 'allowed', text: 's3nh4-real', secret: true, event: 2 }
        : { status: 'allowed' }
    client.rounds = [
      () => call('c0', 'desktop_look', {}),
      () => call('c1', 'desktop_type', { text: 'secret://erp', label: 'Senha' }),
      () => call('c2', 'desktop_type', { text: 'secret://erp', label: 'Senha', element: '1' }),
      () => say('Entrei.')
    ]
    fake.script = (i, d) => {
      if (i.kind === 'click') d.focusedField = { name: 'Senha', type: 'edit', password: true, pid: 70 }
    }
    // first try: nothing focused (no element) → refused; then the model points at the password field
    await work(task())
    const typed = fake.inputs.filter((i) => i.kind === 'type').map((i) => i.detail)
    expect(typed).toEqual(['s3nh4-real'])
    const tools = client.bodies[3].messages.filter((m) => m.role === 'tool').map(text)
    expect(tools[1]).toMatch(/^NÃO DIGITEI/)
    expect(tools[2].startsWith('ok: digitei em "Senha": [segredo]')).toBe(true)
    for (const b of client.bodies) expect(JSON.stringify(b)).not.toContain('s3nh4')
    expect(JSON.stringify(client.progress_)).not.toContain('s3nh4')
  })

  it('does not act blind after the person used the computer: it shows the screen again', async () => {
    fake.fg = 7
    client.rounds = [
      () => call('c1', 'desktop_look', {}),
      () => {
        fake.human() // the person moved the mouse while the model was thinking
        fake.advance(5000) // …and stopped a while ago
        return call('c2', 'desktop_click', { label: 'Salvar', element: '0' })
      },
      () => say('ok')
    ]
    await work(task())
    expect(fake.inputs.some((i) => i.kind === 'click')).toBe(false)
    expect(client.gates).toHaveLength(0)
    const out = client.bodies[2].messages.filter((m) => m.role === 'tool').map(text)
    expect(out[1]).toMatch(/^NÃO EXECUTEI: a pessoa usou o computador/)
  })

  it('refuses apps that are not allowed and Windows shortcuts without asking the platform', async () => {
    fake.fg = 7
    client.rounds = [
      () => [
        ...call('c1', 'desktop_open', { app: 'Excel' }),
        ...call('c2', 'desktop_key', { key: 'Tab', modifiers: ['alt'] })
      ],
      () => say('não deu')
    ]
    await work(task())
    const out = client.bodies[1].messages.filter((m) => m.role === 'tool').map(text)
    expect(out[0]).toMatch(/não está liberado/)
    expect(out[1]).toMatch(/^NÃO APERTEI/)
    expect(client.gates).toHaveLength(0)
    expect(fake.inputs.some((i) => i.kind === 'key')).toBe(false)
  })

  it('opens an allowed app that is closed through its shortcut', async () => {
    fake.wins = fake.wins.filter((w) => w.hwnd !== 7)
    fake.launches.set(
      NOTEPAD.launch!,
      fakeWindow({ hwnd: 11, title: 'Sem título - Bloco de Notas', process: 'notepad' })
    )
    client.rounds = [() => call('c1', 'desktop_open', { app: 'bloco de notas' }), () => say('aberto')]
    await work(task())
    expect(fake.inputs.find((i) => i.kind === 'launch')?.detail).toBe(NOTEPAD.launch)
    expect(client.gates[0]).toMatchObject({ tool: 'desktop:open', args: { app: 'Bloco de Notas' } })
    expect(text(client.bodies[1].messages.find((m) => m.role === 'tool'))).toMatch(/^ok: Bloco de Notas aberto/)
  })

  it('the kill switch releases the keys and hands the task back', async () => {
    fake.fg = 7
    let stopping: Promise<void> | undefined
    client.rounds = [
      () => {
        stopping = worker.stop()
        return call('c1', 'desktop_type', { text: 'não deve sair' })
      }
    ]
    await work(task())
    await stopping
    expect(fake.inputs.some((i) => i.kind === 'type')).toBe(false)
    expect(fake.inputs.some((i) => i.kind === 'release')).toBe(true)
    expect(client.results.at(-1)).toMatchObject({ id: 41, status: 'waiting' })
    expect(JSON.stringify(client.progress_)).toContain('Parado pela pessoa')
  })
})
