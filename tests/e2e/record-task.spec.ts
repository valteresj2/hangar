// "Gravar uma tarefa" end to end, on a pretend computer (HANGAR_COMPUTER_DRIVER=fake) and a mock platform: the person
// picks the app and starts recording (the red indicator shows), does the task (the pretend computer reports what she
// did — a password field without its value, a click in another app only as "outside"), stops, reviews (deletes a
// step, explains in writing because there is no speech model), sends, answers the draft's question and hires in
// shadow mode, sharing this computer for the rehearsals.
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { mockRecordings, type MockRecordings } from '../mock-platform/recordings.ts'
import { mockSharedComputer, type MockSharedComputer } from '../mock-platform/shared-computer.ts'
import { expect, test, type Hangar } from './fixtures.ts'

test.use({ appEnv: { HANGAR_COMPUTER_DRIVER: 'fake' } })

let platform: MockPlatform
let recs: MockRecordings
let shared: MockSharedComputer

test.beforeEach(async () => {
  recs = mockRecordings()
  shared = mockSharedComputer()
  platform = await startMockPlatform({
    extraRoutes: async (req, res, ctx) => (await recs.routes(req, res, ctx)) || shared.routes(req, res, ctx)
  })
})
test.afterEach(async () => {
  await platform.close()
})

const did = (hangar: Hangar, e: Record<string, unknown>): Promise<void> =>
  hangar.app.evaluate((_electron, ev) => {
    ;(globalThis as unknown as { __hangarComputerFake: { did(e: unknown): void } }).__hangarComputerFake.did(ev)
  }, e)

async function recordingPill(hangar: Hangar): Promise<string> {
  for (const w of hangar.app.windows()) {
    if (!w.url().startsWith('data:text/html')) continue
    const t = await w
      .locator('#pill')
      .textContent({ timeout: 500 })
      .catch(() => null)
    if (t && t.includes('Grava')) return t
  }
  return ''
}

test('gravar uma tarefa: gravar, revisar, enviar, responder e contratar em modo sombra', async ({ hangar }) => {
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
  await page.getByRole('button', { name: 'Gravar uma tarefa', exact: true }).click()
  await page.getByTestId('record-title').fill('Resumo da semana')
  await page
    .getByTestId('computer-apps')
    .getByLabel(/Bloco de Notas/)
    .first()
    .check()
  await page.getByLabel('Gravar o microfone (a sua explicação)').uncheck()
  await page.getByTestId('record-start').click()
  await expect(page.getByTestId('record-active')).toBeVisible()
  await expect.poll(() => recordingPill(hangar)).toContain('Gravando')

  // she does the task
  await did(hangar, { kind: 'window', process: 'notepad', window: 'Sem título - Bloco de Notas' })
  await did(hangar, {
    kind: 'click',
    process: 'notepad',
    window: 'Sem título - Bloco de Notas',
    element: { name: 'Texto', type: 'document' },
    frame: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  })
  await did(hangar, { kind: 'type', process: 'notepad', field: 'Texto', value: 'resumo da semana' })
  await did(hangar, { kind: 'type', process: 'notepad', field: 'Senha', password: true, value: 'nunca-isto' })
  await did(hangar, { kind: 'click', process: 'chrome', window: 'Banco — saldo' })
  await did(hangar, { kind: 'click', process: 'notepad', element: { name: 'Salvar', type: 'button' } })
  await expect(page.getByTestId('record-active')).toContainText('5 passos')

  await page.getByTestId('record-stop').click()
  const review = page.getByTestId('record-review')
  await expect(review).toBeVisible()
  const timeline = page.getByTestId('record-timeline')
  await expect(timeline).toContainText('escreveu "resumo da semana" no campo "Texto"')
  await expect(timeline).toContainText('digitou a senha no campo "Senha"')
  await expect(timeline).toContainText('clicou em outro app (não gravado)')
  await expect(timeline).not.toContainText('Banco')
  await expect(timeline.locator('img')).toHaveCount(1)
  // the indicator is gone
  await expect.poll(() => recordingPill(hangar)).toBe('')

  // she deletes the "outside" step and explains in writing
  const steps = timeline.locator('li')
  const before = await steps.count()
  await steps.filter({ hasText: 'outro app' }).getByRole('button', { name: 'Apagar' }).click()
  await expect(steps).toHaveCount(before - 1)
  await page.getByTestId('record-notes').fill('Toda segunda às 9h escrevo o resumo da semana e salvo.')
  await page.getByTestId('record-send').click()

  // the package: the steps (no password value), the explanation, the capture
  await expect(page.getByTestId('record-draft')).toBeVisible()
  expect(recs.packages).toHaveLength(1)
  const pkg = recs.packages[0]
  expect(JSON.stringify(pkg)).not.toContain('nunca-isto')
  expect(JSON.stringify(pkg)).not.toContain('Banco')
  expect(pkg).toMatchObject({ title: 'Resumo da semana', notes: expect.stringContaining('Toda segunda') })
  expect((pkg.frames as unknown[]).length).toBe(1)

  // hiring waits for the answer
  await page.getByTestId('record-hire').click()
  await expect(page.getByText('Responda a pergunta do rascunho.')).toBeVisible()
  await page.getByTestId('record-answer').fill('Do e-mail da equipe.')
  await expect(page.getByTestId('record-cron')).toHaveValue('0 9 * * 1')
  await page.getByTestId('record-hire').click()
  await expect(page.getByTestId('record-hired')).toContainText('Lançador de notas')

  // shared this computer (asking each loan, with the recording's app) and hired with it
  expect(shared.registered?.body).toMatchObject({
    auth_mode: 'ask',
    allow_managed: true,
    apps: [{ name: 'Bloco de Notas', process: 'notepad' }]
  })
  expect(recs.hires).toHaveLength(1)
  expect(recs.hires[0]).toMatchObject({
    workstation_id: 41,
    draft: { schedule: { cron: '0 9 * * 1' }, questions: [{ answer: 'Do e-mail da equipe.' }] }
  })
})

test('o botão ● Gravar na caixa de nova sessão grava e, ao parar, abre a revisão', async ({ hangar }) => {
  const { page } = hangar
  await page.getByTestId('composer-record').click()
  const panel = page.getByTestId('composer-record-panel')
  await panel
    .getByLabel(/Bloco de Notas/)
    .first()
    .check()
  await panel.getByLabel('Microfone (a sua explicação)').uncheck()
  await page.getByTestId('composer-record-start').click()
  const stop = page.getByTestId('composer-record-stop')
  await expect(stop).toContainText('Parar')
  await expect.poll(() => recordingPill(hangar)).toContain('Gravando')
  await did(hangar, { kind: 'click', process: 'notepad', element: { name: 'Salvar', type: 'button' } })
  await page.waitForTimeout(800)
  await stop.click()
  await expect(page.getByTestId('record-review')).toBeVisible()
  await expect(page.getByTestId('record-timeline')).toContainText('clicou em button "Salvar"')
})
