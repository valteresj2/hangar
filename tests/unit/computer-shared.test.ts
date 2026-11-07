// This computer lent to the platform's employees (src/main/features/computer/shared.ts): the loop asks the person once
// per loan request, runs the steps the platform already cleared — with the local rules (allowed apps, the window,
// Windows shortcuts refused, secrets only into password fields, not acting blind after the person used the computer)
// — sends the screen back, and Stop ends the loan in use and releases every key.
import { describe, expect, it } from 'vitest'
import type { LeaseInfo } from '../../src/shared/features/computer'
import { FAKE_PNG, FakeDriver, fakeWindow } from '../../src/main/features/computer/driver/fake'
import { Presence } from '../../src/main/features/computer/presence'
import { SharedMachine, type Beat, type Step, type StepResult } from '../../src/main/features/computer/shared'

const ERP = { name: 'ERP Legado', process: 'erp', launch: 'C:\\ERP\\erp.exe' }

const lease = (over: Partial<LeaseInfo> = {}): LeaseInfo => ({
  lease_id: 5,
  request_id: 9,
  employee: 'Engenheiro de Dados',
  employee_slug: 'engenheiro-de-dados',
  task_id: 77,
  task_title: 'Baixa da fatura 88',
  app: 'ERP Legado',
  reason: 'dar baixa',
  status: 'requested',
  ...over
})

function setup() {
  const fake = new FakeDriver({
    windows: [
      fakeWindow({ hwnd: 3, title: 'ERP Legado 7.2', process: 'erp' }),
      fakeWindow({ hwnd: 4, title: 'Planilha', process: 'excel' })
    ],
    foreground: 4
  })
  fake.elementsOf.set(3, [
    { name: 'Senha', type: 'edit', password: true, x: 300, y: 300, width: 200, height: 20, value: '' },
    { name: 'Confirmar baixa', type: 'button', password: false, x: 500, y: 600, width: 100, height: 30, value: '' }
  ])
  const beats: Beat[] = []
  const results: { id: number; res: StepResult }[] = []
  const answers: { id: number; allow: boolean }[] = []
  const stops: number[] = []
  const prompts: LeaseInfo[] = []
  const ref = {} as { machine: SharedMachine }
  const client = {
    async heartbeat(): Promise<Beat> {
      const b = beats.shift()
      if (!b) {
        void ref.machine.stop()
        return { workstation: { id: 1, name: 'PC', online: true }, requests: [], active: null, step: null }
      }
      return b
    },
    async result(id: number, res: StepResult) {
      results.push({ id, res })
      return {}
    },
    async answer(id: number, allow: boolean) {
      answers.push({ id, allow })
      return {}
    },
    async stop(id: number) {
      stops.push(id)
      return {}
    }
  }
  ref.machine = new SharedMachine({
    client,
    driver: fake,
    apps: () => [ERP],
    selfPid: 1,
    ignoreHwnds: () => [],
    presence: new Presence(1000),
    info: () => ({ name: 'PC' }),
    events: {
      state: () => undefined,
      action: () => undefined,
      target: () => undefined,
      prompt: (r) => prompts.push(r),
      revoked: () => undefined,
      error: () => undefined
    },
    sleep: async (ms) => fake.advance(ms),
    waitS: 0
  })
  const ws = { id: 1, name: 'PC', online: true }
  const beat = (b: Partial<Beat>): Beat => ({ workstation: ws, requests: [], active: null, step: null, ...b })
  return { fake, machine: ref.machine, beats, results, answers, stops, prompts, beat }
}

describe('shared computer', () => {
  it('asks the person once per loan request and answers what she chose', async () => {
    const t = setup()
    const r = lease()
    t.beats.push(t.beat({ requests: [r] }), t.beat({ requests: [r] }))
    await t.machine.start()
    expect(t.prompts.map((p) => p.lease_id)).toEqual([5])
    await t.machine.answer(5, true)
    expect(t.answers).toEqual([{ id: 5, allow: true }])
  })

  it('runs the cleared steps on the allowed app and sends the screen back', async () => {
    const t = setup()
    const active = lease({ status: 'active' })
    const step = (id: number, command: Step['command'], args: Record<string, unknown>): Beat =>
      t.beat({ active, step: { id, command, args } })
    t.beats.push(
      step(1, 'open', { app: 'ERP Legado' }),
      step(2, 'click', { element: '1' }),
      step(3, 'type_text', { text: 's3nh4', secret: true }), // the click before focused the password field
      step(4, 'type_text', { text: 's3nh4', secret: true, element: '0' }),
      step(5, 'key', { key: 'Tab', modifiers: ['alt'] }),
      step(6, 'open', { app: 'Excel' })
    )
    t.fake.script = (i, d) => {
      if (i.kind === 'click') d.focusedField = { name: 'Senha', type: 'edit', password: true, pid: 30 }
    }
    await t.machine.start()
    const r = Object.fromEntries(t.results.map((x) => [x.id, x.res]))
    expect(r[1]).toMatchObject({ ok: true, window: 'ERP Legado 7.2', app: 'ERP Legado', screenshot: FAKE_PNG })
    expect((r[1] as { elements: string[] }).elements[1]).toMatch(/\[1\] button "Confirmar baixa"/)
    expect(t.fake.inputs.find((i) => i.kind === 'focus')?.detail).toBe('3') // the allowed app, not the spreadsheet in front
    expect(t.fake.inputs.find((i) => i.kind === 'click')?.detail).toBe('550,615') // element 1's centre on the screen
    expect(t.fake.inputs.filter((i) => i.kind === 'type').map((i) => i.detail)).toEqual(['s3nh4', 's3nh4'])
    expect(r[5]).toEqual({ error: expect.stringMatching(/^NÃO APERTEI/) })
    expect(r[6]).toEqual({ error: expect.stringMatching(/não está liberado/) })
  })

  it('refuses a secret when the focused field is not a password field', async () => {
    const t = setup()
    const active = lease({ status: 'active' })
    t.fake.fg = 3
    t.fake.focusedField = { name: 'Fatura', type: 'edit', password: false, pid: 30 }
    t.beats.push(t.beat({ active, step: { id: 1, command: 'type_text', args: { text: 's3nh4', secret: true } } }))
    await t.machine.start()
    expect(t.results[0].res).toEqual({ error: expect.stringMatching(/^NÃO DIGITEI/) })
    expect(t.fake.inputs.some((i) => i.kind === 'type')).toBe(false)
  })

  it('does not act blind after the person used the computer', async () => {
    const t = setup()
    const active = lease({ status: 'active' })
    t.fake.fg = 3
    t.beats.push(t.beat({ active, step: { id: 1, command: 'look', args: {} } }))
    t.beats.push(t.beat({ active, step: { id: 2, command: 'click', args: { element: '1' } } }))
    const hb = t.machine as unknown as { d: { client: { heartbeat(): Promise<Beat> } } }
    const orig = hb.d.client.heartbeat.bind(hb.d.client)
    let n = 0
    hb.d.client.heartbeat = async () => {
      if (++n === 2) {
        t.fake.human()
        t.fake.advance(5000)
      }
      return orig()
    }
    await t.machine.start()
    expect(t.results[1].res).toMatchObject({ ok: false, detail: expect.stringMatching(/^NÃO EXECUTEI/) })
    expect(t.fake.inputs.some((i) => i.kind === 'click')).toBe(false)
  })

  it('Stop does not wait for the long-poll in flight', async () => {
    const t = setup()
    const hb = t.machine as unknown as {
      d: { client: { heartbeat(i: object, w: number, cancel?: AbortSignal): Promise<Beat> } }
    }
    // a heartbeat that only ends when it is cancelled (the server holding the long-poll)
    hb.d.client.heartbeat = (_i, _w, cancel) =>
      new Promise((_resolve, reject) => cancel?.addEventListener('abort', () => reject(new Error('aborted'))))
    const run = t.machine.start()
    await new Promise((r) => setTimeout(r, 10))
    const t0 = Date.now()
    await t.machine.stop()
    await run
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('Stop ends the loan in use and releases every key', async () => {
    const t = setup()
    t.beats.push(t.beat({ active: lease({ status: 'active' }) }))
    const run = t.machine.start()
    await new Promise((r) => setTimeout(r, 10))
    await t.machine.stop()
    await run
    expect(t.stops).toEqual([5])
    expect(t.fake.inputs.some((i) => i.kind === 'release')).toBe(true)
  })
})
