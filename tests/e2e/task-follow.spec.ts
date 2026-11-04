// Following a Digital employee task from the session that started it: the session's assign_task (platform MCP) makes
// the session follow the task; a card above the composer shows it live (task.updated → GET /api/tasks/{id}); when it
// ends, the session gets the result as a message and answers.
import { TEXT_REPLY } from '../mock-anthropic/scripts.ts'
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { expect, test } from './fixtures.ts'

let platform: MockPlatform

test.beforeEach(async () => {
  platform = await startMockPlatform({ log: process.env.MOCK_LOG ? (l) => console.log(`[platform] ${l}`) : undefined })
})
test.afterEach(async () => {
  await platform.close()
})

test('a sessão acompanha a tarefa que passou até o fim e retoma a conversa com o resultado', async ({
  hangar,
  mock
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
  await expect.poll(() => platform.streams()).toBe(1)
  await hangar.useMockProvider()
  await hangar.openNewSession({ title: 'Passar tarefa' })

  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill('[[script:assign-task title=Relatório-de-vendas]] passe a tarefa ao analista')
  await composer.press('Enter')
  // The platform tool asks first, like any action that changes something.
  await page.getByRole('button', { name: 'Permitir', exact: true }).click({ timeout: 60_000 })
  await expect(page.getByText('Tarefa passada ao funcionário.')).toBeVisible({ timeout: 60_000 })

  // The card shows up as soon as the assign_task answer arrives.
  const card = page.locator('[data-follow-task="901"]')
  await expect(card).toContainText('#901 · Relatório-de-vendas')
  await expect(card).toContainText('na fila')

  // The employee works: plan and timeline arrive with task.updated.
  const t = platform.tasks.get(901)!
  Object.assign(t, {
    status: 'in_progress',
    plan: [
      { title: 'Ler os dados', status: 'done' },
      { title: 'Montar o relatório', status: 'doing' }
    ],
    progress: { done: 1, total: 2, pct: 50 },
    cost_usd: 0.12
  })
  ;(t.events as unknown[]).push({
    kind: 'note',
    payload: { worker: 'baixando as vendas de outubro' },
    at: new Date().toISOString()
  })
  platform.emitEvent('task.updated', { id: 901, status: 'in_progress' })
  await expect(card).toContainText('trabalhando')
  await expect(card).toContainText('Montar o relatório')
  await expect(card).toContainText('baixando as vendas de outubro')
  if (process.env.SHOT) await page.screenshot({ path: 'test-results/follow-working.png' })

  // It ends: the result is in the card, and the session gets it as a message and answers.
  Object.assign(t, { status: 'done', result: 'Relatório pronto: as vendas subiram 12% em outubro.' })
  platform.emitEvent('task.updated', { id: 901, status: 'done' })
  await expect(card).toContainText('concluída')
  await expect(card).toContainText('as vendas subiram 12% em outubro')
  await expect(page.getByText(/\[Agent Hangar\] A tarefa #901/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(TEXT_REPLY).first()).toBeVisible({ timeout: 60_000 })
  if (process.env.SHOT) await page.screenshot({ path: 'test-results/follow-done.png' })
  const wake = mock.requests.filter((r) => r.path === '/v1/messages').at(-1)
  expect(JSON.stringify(wake?.body)).toContain('as vendas subiram 12% em outubro')

  // Only once: another event with the same status does not wake the session again.
  const before = mock.requests.filter((r) => r.path === '/v1/messages').length
  platform.emitEvent('task.updated', { id: 901, status: 'done' })
  await page.waitForTimeout(3_000)
  expect(mock.requests.filter((r) => r.path === '/v1/messages').length).toBe(before)
})
