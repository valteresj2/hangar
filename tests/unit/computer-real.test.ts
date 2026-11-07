// Opt-in (HANGAR_REAL_COMPUTER=1, Windows): the computer workstation on the REAL screen — the C# helper compiled with
// the in-box csc.exe, real window capture, UI Automation, SendInput — against a tiny WinForms "Mini ERP" compiled on
// the fly (tests/computer/MiniErp.cs), never one of the person's apps. The worker opens it, fills the invoice, types
// a secret only into the password field, "Lançar" waits for the approval with the screenshot, then runs, and the
// "Sim" of the confirmation dialog is covered by the same approval. It moves the mouse and types: do not touch the
// computer while it runs (touching it pauses the worker, as designed).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AllowedApp } from '../../src/shared/features/computer'
import {
  parseAgui,
  type AguiEvent,
  type AguiMessage,
  type GateResult,
  type WorkerTask
} from '../../src/main/features/computer/agui'
import { WindowsDriver } from '../../src/main/features/computer/driver/windows'
import { Presence } from '../../src/main/features/computer/presence'
import { Worker } from '../../src/main/features/computer/worker'

const REAL = process.env.HANGAR_REAL_COMPUTER === '1' && process.platform === 'win32'
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

type Round = (messages: AguiMessage[]) => object[]
const call = (id: string, name: string, args: object): object[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) }
]
const lastTool = (ms: AguiMessage[]): string => {
  const m = [...ms].reverse().find((x) => x.role === 'tool')
  return typeof m?.content === 'string' ? m.content : ''
}
/** The number of an element in the last screen the model got (`[n] edit "Fatura"`). */
const el = (ms: AguiMessage[], type: string, name: string): string => {
  const m = new RegExp(`\\[(\\d+)\\] ${type} "${name}"`).exec(lastTool(ms))
  if (!m) throw new Error(`sem ${type} "${name}" na tela:\n${lastTool(ms)}`)
  return m[1]
}

describe.skipIf(!REAL)('computer workstation on the real screen (opt-in)', () => {
  let dir: string
  let exe: string
  let log: string
  const children: ChildProcess[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-real-computer-'))
    exe = join(dir, 'MiniErp.exe')
    log = join(dir, 'lancamentos.log')
    execFileSync(CSC, [
      '-nologo',
      '-target:winexe',
      `-out:${exe}`,
      '-r:System.Windows.Forms.dll',
      '-r:System.Drawing.dll',
      resolve('tests/computer/MiniErp.cs')
    ])
  })
  afterAll(() => {
    for (const c of children) c.kill()
    try {
      execFileSync('taskkill', ['/IM', 'MiniErp.exe', '/F'], { stdio: 'ignore' })
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens the app, fills it, waits for the approval and posts the invoice', async () => {
    const driver = new WindowsDriver(join(dir, 'helper'), async (target) => {
      children.push(spawn(target, [log], { detached: true, stdio: 'ignore' }))
      return ''
    })
    const app: AllowedApp = { name: 'Mini ERP', process: 'MiniErp', launch: exe }
    const gates: { tool: string; args: Record<string, unknown>; screenshot: boolean }[] = []
    let approved = 0
    let last: Round | undefined
    const rounds: Round[] = [
      () => call('c1', 'desktop_open', { app: 'Mini ERP' }),
      (ms) => call('c2', 'desktop_type', { text: '88', label: 'Fatura', element: el(ms, 'edit', 'Fatura') }),
      (ms) => call('c3', 'desktop_type', { text: '1500', label: 'Valor', element: el(ms, 'edit', 'Valor') }),
      (ms) => call('c4', 'desktop_type', { text: 'secret://erp', label: 'Senha', element: el(ms, 'edit', 'Senha') }),
      (ms) => call('c5', 'desktop_click', { label: 'Lançar', element: el(ms, 'button', 'Lançar') }),
      (ms) => call('c6', 'desktop_click', { label: 'Sim', element: el(ms, 'button', 'Sim') }),
      () => [{ type: 'TEXT_MESSAGE_CONTENT', delta: 'Fatura 88 lançada.' }]
    ]
    const client = {
      heartbeat: async () => ({ employee: 'x', name: 'x', status: 'active', task: null, next_heartbeat_s: 1 }),
      progress: async () => ({ status: 'in_progress', cost_usd: 0, stop: false }),
      results: [] as string[],
      async result(_id: number, status: string) {
        this.results.push(status)
        return { status }
      },
      async gate(_t: number, tool: string, args: object, _r = '', screenshot = ''): Promise<GateResult> {
        const a = args as Record<string, unknown>
        gates.push({ tool, args: a, screenshot: !!screenshot })
        if (tool === 'desktop:type' && a.text === 'secret://erp')
          return { status: 'allowed', text: 's3nh4-erp', secret: true }
        if (tool === 'desktop:click' && a.label === 'Lançar' && !approved) return { status: 'waiting', request_id: 1 }
        if (tool === 'desktop:click' && a.label === 'Lançar')
          return { status: 'allowed', approved: 1, where: { x: a.x as number, y: a.y as number } }
        return { status: 'allowed', ...(a.label === 'Sim' ? { covered_by: 1 } : {}) }
      },
      async *agui(_id: number, body: object, names: ReadonlySet<string>): AsyncGenerator<AguiEvent> {
        const ms = (body as { messages: AguiMessage[] }).messages
        // like a model would: a step not executed because the person used the computer is done again on the new screen
        const retry = lastTool(ms).startsWith('NÃO EXECUTEI') && last
        const r = retry ? last : rounds.shift()
        if (!r) throw new Error('rodada inesperada')
        last = r
        const evs = r(ms).map((e) =>
          retry && 'toolCallId' in e
            ? { ...e, toolCallId: `${String((e as { toolCallId: string }).toolCallId)}-again` }
            : e
        )
        async function* lines(): AsyncGenerator<string> {
          for (const e of evs) yield `data: ${JSON.stringify(e)}\n`
        }
        yield* parseAgui(lines(), names)
      }
    }
    const statuses: string[] = []
    const worker = new Worker({
      client,
      driver,
      stateDir: join(dir, 'state'),
      apps: () => [app],
      selfPid: process.pid,
      ignoreHwnds: () => [],
      info: () => ({ name: 'teste real' }),
      presence: new Presence(1500),
      events: {
        status: (st) => statuses.push(JSON.stringify(st)),
        action: (a) => statuses.push(JSON.stringify(a)),
        target: () => undefined,
        revoked: () => undefined
      }
    })
    await driver.start()
    const task: WorkerTask = {
      id: 1,
      title: 'Lançar a fatura 88',
      body: '',
      run: 1,
      url: '',
      messages: [{ role: 'user', content: 'Lance a fatura 88.' }],
      decisions: [],
      budget_usd: 1,
      cost_usd: 0,
      time_limit_min: 30
    }
    const work = (t: WorkerTask): Promise<void> => (worker as unknown as { work(t: WorkerTask): Promise<void> }).work(t)
    await work(task)
    expect(gates.at(-1)).toMatchObject({ tool: 'desktop:click', args: { label: 'Lançar' }, screenshot: true })
    expect(existsSync(log)).toBe(false) // nothing posted before the approval
    approved = 1
    await work({
      ...task,
      run: 2,
      decisions: [{ id: 1, kind: 'approval', status: 'approved', decision: 'approve', tool: 'desktop:click' }]
    })
    driver.dispose()
    if (client.results.at(-1) !== 'done') console.log(statuses.join('\n'))
    expect(client.results.at(-1)).toBe('done')
    expect(readFileSync(log, 'utf8')).toMatch(/fatura=88\tvalor=1500\tsenha_ok=sim/)
    expect(JSON.stringify(gates)).not.toContain('s3nh4')
  }, 120_000)
})
