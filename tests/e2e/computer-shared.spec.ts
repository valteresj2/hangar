// A shared computer end to end, on a pretend computer (HANGAR_COMPUTER_DRIVER=fake) and a mock platform: the person
// shares this computer (asks each loan, employees she manages), an employee asks to borrow it and she allows it in the
// panel; the steps the platform already cleared run here and the screen goes back; the indicator says who is using it;
// Stop ends the loan; and she stops sharing.
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { mockSharedComputer, type MockSharedComputer } from '../mock-platform/shared-computer.ts'
import { expect, test, type Hangar } from './fixtures.ts'

test.use({ appEnv: { HANGAR_COMPUTER_DRIVER: 'fake' } })

let platform: MockPlatform
let shared: MockSharedComputer

test.beforeEach(async () => {
  shared = mockSharedComputer()
  platform = await startMockPlatform({ extraRoutes: (req, res, ctx) => shared.routes(req, res, ctx) })
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

test('compartilhar o computador: pedido de uso, passos de tela, aviso, Parar e parar de compartilhar', async ({
  hangar
}) => {
  const { page, invoke, app } = hangar
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  await invoke('platform:connect')
  await expect.poll(async () => (await invoke<{ status: string }>('platform:state')).status).toBe('connected')

  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Posto no computador', exact: true }).click()
  await expect(page.getByText('Compartilhar este computador').first()).toBeVisible()
  // the defaults: ask each loan, the employees she manages
  await expect(page.getByRole('radio', { name: 'Perguntar a cada uso' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('computer-who').getByLabel('funcionários que eu gerencio')).toBeChecked()
  await page
    .getByTestId('computer-apps')
    .first()
    .getByLabel(/Bloco de Notas/)
    .first()
    .check()
  await page.getByRole('button', { name: 'Compartilhar este computador' }).click()

  await expect(page.getByTestId('computer-status')).toBeVisible()
  expect(shared.registered?.body).toMatchObject({
    auth_mode: 'ask',
    allow_managed: true,
    apps: [{ name: 'Bloco de Notas', process: 'notepad' }]
  })
  await expect.poll(() => shared.beats).toBeGreaterThan(0)

  // an employee asks to borrow it: the request shows up; she allows it here
  shared.ask({ lease_id: 7 })
  const req = page.getByTestId('computer-requests')
  await expect(req).toContainText('Engenheiro de Dados quer usar este computador para a tarefa #1530', {
    timeout: 10_000
  })
  await req.getByRole('button', { name: 'Permitir' }).click()
  await expect.poll(() => shared.answers).toEqual([{ lease: 7, allow: true }])

  // the cleared steps run here; the screen goes back; the indicator says who is using it
  const s1 = shared.step('open', { app: 'Bloco de Notas' })
  const s2 = shared.step('click', { element: '1' })
  const s3 = shared.step('key', { key: 'Tab', modifiers: ['alt'] })
  await expect.poll(() => shared.results.size, { timeout: 15_000 }).toBe(3)
  expect(shared.results.get(s1)).toMatchObject({
    ok: true,
    window: 'Sem título - Bloco de Notas',
    app: 'Bloco de Notas'
  })
  expect(shared.results.get(s1)?.screenshot).toEqual(expect.stringMatching(/^.{10,}$/))
  expect(shared.results.get(s3)).toMatchObject({ error: expect.stringMatching(/^NÃO APERTEI/) })
  expect((await inputs(hangar)).some((i) => i.kind === 'click')).toBe(true)
  expect(s2).toBeGreaterThan(0)
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'working')
  await expect.poll(() => pillText(hangar)).toMatch(/Engenheiro de Dados está usando este computador/)
  await expect(page.getByTestId('computer-recent')).toContainText('Bloco de Notas')

  // Stop: the loan ends at once and every key goes up
  await page.getByRole('button', { name: /^Parar \(/ }).click()
  await expect.poll(() => shared.stops).toEqual([7])
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'stopped')
  expect((await inputs(hangar)).some((i) => i.kind === 'release')).toBe(true)

  // she stops sharing: the platform forgets this computer
  await page.getByRole('button', { name: 'Parar de compartilhar' }).click()
  await expect.poll(() => shared.deleted).toBe(true)
  await expect(page.getByRole('button', { name: 'Compartilhar este computador' })).toBeVisible()
})
