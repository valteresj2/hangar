// The computer workstation end to end, on a pretend computer (HANGAR_COMPUTER_DRIVER=fake: nothing real moves) and a
// mock platform: the person turns it on for an employee they manage and picks the allowed app; the employee gets a
// task, looks at the screen and types; the indicator shows; the person touches the mouse and it pauses, then does not
// act blind; Ctrl+S waits for the approval with the screenshot and runs after it; the result goes back. Then the kill
// switch: Parar hands the task back and releases the keys.
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { call, mockWorkstation, say, type MockWorkstation } from '../mock-platform/workstation.ts'
import { expect, test, type Hangar } from './fixtures.ts'

test.use({ appEnv: { HANGAR_COMPUTER_DRIVER: 'fake' } })

let platform: MockPlatform
let ws: MockWorkstation

test.beforeEach(async () => {
  ws = mockWorkstation()
  platform = await startMockPlatform({
    log: process.env.MOCK_LOG ? (l) => console.log(`[platform] ${l}`) : undefined,
    extraRoutes: (req, res, ctx) => ws.routes(req, res, ctx)
  })
})
test.afterEach(async () => {
  await platform.close()
})

interface FakeInputs {
  kind: string
  detail: string
}
const inputs = (hangar: Hangar): Promise<FakeInputs[]> =>
  hangar.app.evaluate(
    () => (globalThis as unknown as { __hangarComputerFake: { inputs: FakeInputs[] } }).__hangarComputerFake.inputs
  )
const human = (hangar: Hangar): Promise<void> =>
  hangar.app.evaluate(() =>
    (globalThis as unknown as { __hangarComputerFake: { human(): void } }).__hangarComputerFake.human()
  )

const pillVisible = (hangar: Hangar): Promise<boolean> =>
  hangar.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'Agent Hangar — posto no computador' && w.isVisible())
  )

/** The indicator window (a data: page with the pill). */
async function pillText(hangar: Hangar): Promise<string> {
  for (const w of hangar.app.windows()) {
    if (!w.url().startsWith('data:text/html')) continue
    const t = await w
      .locator('#pill')
      .textContent({ timeout: 500 })
      .catch(() => null)
    if (t !== null) return t
  }
  return ''
}

test('o funcionário trabalha na tela do computador: aviso, pausa, alçada com a captura e o botão Parar', async ({
  hangar
}, testInfo) => {
  const { page, invoke, app } = hangar
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  await invoke('platform:connect')
  await expect.poll(async () => (await invoke<{ status: string }>('platform:state')).status).toBe('connected')

  // The task waits in the queue; round 2 holds until the test lets it go (so it can check the indicator and pause).
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  ws.gate = (tool) => (tool === 'desktop:key' ? 'waiting' : 'allowed')
  const task = ws.addTask({
    id: 501,
    title: 'Nota da reunião',
    body: 'Escreva a pauta no Bloco de Notas e salve.',
    rounds: [
      () => [...say('Vou olhar a tela.'), ...call('c1', 'desktop_look', {})],
      async () => {
        await held
        return call('c2', 'desktop_type', { text: 'Pauta: orçamento', label: 'Texto' })
      },
      () => call('c3', 'desktop_type', { text: 'Pauta: orçamento', label: 'Texto' }),
      () => call('c4', 'desktop_key', { key: 's', modifiers: ['ctrl'] }),
      () => say('Nota salva no Bloco de Notas.')
    ]
  })

  // Configurações → Posto no computador: off by default; the person picks the employee and the allowed app.
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Posto no computador', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Posto no computador' })).toBeVisible()
  await expect(page.getByText('Ou: o posto de um funcionário neste computador')).toBeVisible()
  await page.getByTestId('computer-employee').selectOption('assistente-adm')
  const apps = page.getByTestId('computer-apps').last()
  await apps
    .getByLabel(/Bloco de Notas/)
    .first()
    .check()
  await invoke('computer:setResumeAfter', 3)
  await page.screenshot({ path: testInfo.outputPath('ligar.png') })
  await page.getByRole('button', { name: 'Ligar neste computador' }).click()

  await expect(page.getByTestId('computer-status')).toBeVisible()
  expect(ws.runtimeCalls).toEqual([{ slug: 'assistente-adm', runtime: 'external' }])
  await expect.poll(() => ws.worker?.name ?? '').toMatch(/^Computador \(/)
  expect(String(ws.worker?.apps)).toBe('Bloco de Notas')

  // Working: the panel and the always-on-top indicator say so.
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'working', { timeout: 20_000 })
  await expect
    .poll(() => pillText(hangar), { timeout: 10_000 })
    .toMatch(/Assistente Administrativo está usando este computador/)
  expect(await pillVisible(hangar)).toBe(true)
  // The person moves the mouse: it pauses (panel and indicator).
  await human(hangar)
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'paused', { timeout: 10_000 })
  await expect.poll(() => pillText(hangar)).toMatch(/pausou/)
  release()

  // After the quiet time it does not act blind (the screen may have changed): the model gets the screen again and
  // types on the next round; Ctrl+S waits for the decision, with the screenshot in the request.
  await expect.poll(() => ws.requests.length, { timeout: 30_000 }).toBe(1)
  const req = ws.requests[0]
  expect(req).toMatchObject({ tool: 'desktop:key', screenshot: true, args: { key: 's', modifiers: ['ctrl'] } })
  expect((await inputs(hangar)).filter((i) => i.kind === 'type').map((i) => i.detail)).toEqual(['Pauta: orçamento'])
  expect((await inputs(hangar)).some((i) => i.kind === 'key')).toBe(false)
  const typeGates = task.gates.filter((g) => g.tool === 'desktop:type')
  expect(typeGates).toHaveLength(1) // the stale attempt never reached the platform

  // Approved: the task comes back by the heartbeat, Ctrl+S runs, the employee delivers.
  ws.decide(req.id, 'approve')
  await expect.poll(() => task.status, { timeout: 30_000 }).toBe('done')
  expect((await inputs(hangar)).filter((i) => i.kind === 'key').map((i) => i.detail)).toEqual(['ctrl+s'])
  expect(task.results.at(-1)).toEqual({ status: 'done', result: 'Nota salva no Bloco de Notas.' })
  const steps = task.progress.map((p) => (p.tool as { name?: string } | undefined)?.name).filter(Boolean)
  expect(steps).toEqual(expect.arrayContaining(['desktop_look', 'desktop_type', 'desktop_key']))
  expect(
    task.progress.some((p) => (p.desktop as { after?: string } | undefined)?.after === 'Sem título - Bloco de Notas')
  ).toBe(true)
  await expect(page.getByTestId('computer-recent')).toContainText('ctrl+s')

  // Kill switch: a new task; Parar stops it at once, hands it back and releases every key.
  let release2!: () => void
  const held2 = new Promise<void>((r) => (release2 = r))
  const t2 = ws.addTask({
    id: 502,
    title: 'Outra nota',
    body: 'Escreva outra nota.',
    rounds: [
      async () => {
        await held2
        return call('d1', 'desktop_type', { text: 'não deve sair' })
      }
    ]
  })
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'working', { timeout: 20_000 })
  await page.getByRole('button', { name: /^Parar/ }).click()
  release2()
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'stopped')
  await expect.poll(() => t2.results.at(-1)?.status, { timeout: 10_000 }).toBe('waiting')
  expect(t2.progress.some((p) => String(p.note).includes('Parado pela pessoa'))).toBe(true)
  expect((await inputs(hangar)).some((i) => i.kind === 'release')).toBe(true)
  expect((await inputs(hangar)).filter((i) => i.kind === 'type').map((i) => i.detail)).not.toContain('não deve sair')
  await expect.poll(() => pillVisible(hangar)).toBe(false)

  // Off: the employee goes back to the platform.
  await page.getByRole('button', { name: 'Desligar o posto' }).click()
  await expect(page.getByText('Ou: o posto de um funcionário neste computador')).toBeVisible()
  expect(ws.runtimeCalls.at(-1)).toEqual({ slug: 'assistente-adm', runtime: 'hangar' })
})
