// Following a Digital employee task from the session that started it: the session's assign_task (platform MCP) makes
// the session follow the task; a card above the composer shows it live (task.updated → GET /api/tasks/{id}); when it
// ends, the session gets the result as a message and answers. Inside the card: the task's decisions, the tasks it handed
// off and its deliverables.
import { readFileSync } from 'node:fs'
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

test('no cartão: a decisão da tarefa, o repasse aninhado e os entregáveis que abrem com um clique', async ({
  hangar
}) => {
  const { page, invoke, app } = hangar
  const downloads = await app.evaluate(({ app: electronApp, shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    const dir = `${electronApp.getPath('userData')}/downloads-test`
    electronApp.setPath('downloads', dir)
    shell.openPath = async (p: string) => {
      g.__opened.push(p)
      return ''
    }
    shell.showItemInFolder = (p: string) => void g.__opened.push(`pasta:${p}`)
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text()) // the login page: the mock platform completes it
    }
    return dir
  })
  const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  await invoke('platform:connect')
  await expect.poll(async () => (await invoke<{ status: string }>('platform:state')).status).toBe('connected')
  await expect.poll(() => platform.streams()).toBe(1)
  await hangar.useMockProvider()
  await hangar.openNewSession({ title: 'Fase 2' })

  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill('[[script:assign-task title=Modelo-de-churn]] passe a tarefa ao cientista')
  await composer.press('Enter')
  await page.getByRole('button', { name: 'Permitir', exact: true }).click({ timeout: 60_000 })
  const card = page.locator('[data-follow-task="901"]')
  await expect(card).toContainText('#901 · Modelo-de-churn', { timeout: 60_000 })
  const t = platform.tasks.get(901)!

  // The employee hands part of the work to a colleague: that task shows inside this one's card.
  platform.tasks.set(950, {
    id: 950,
    title: 'Preparar a base',
    status: 'in_progress',
    cost_usd: 0.05,
    tokens: 2000,
    events: [{ kind: 'note', payload: { worker: 'baixando os arquivos' }, at: new Date().toISOString() }],
    requests: [],
    children: [],
    parent: { id: 901, title: 'Modelo-de-churn', status: 'waiting_task', employee_name: 'Cientista' },
    files: []
  })
  Object.assign(t, {
    status: 'waiting_task',
    children: [{ id: 950, title: 'Preparar a base', status: 'in_progress', employee_name: 'Engenheiro' }]
  })
  platform.emitEvent('task.updated', { id: 901, status: 'waiting_task' })
  const child = card.locator('[data-follow-task="950"]')
  await expect(child).toContainText('Preparar a base')
  await expect(child).toContainText('baixando os arquivos')
  await expect(child).toContainText('Engenheiro') // the colleague's name, from the handoff
  await expect(page.locator('[data-follow-task="950"]')).toHaveCount(1) // inside, not also on its own

  // It stops for a decision: approved right in the card.
  platform.decisions.unshift({
    id: 88,
    kind: 'approval',
    employee: 'cientista-de-dados',
    employee_name: 'Cientista',
    employee_title: 'Cientista de Dados',
    task: { id: 901, title: 'Modelo-de-churn' },
    tool: 'publish_github',
    question: 'Publicar o repositório com o modelo?',
    status: 'open',
    created_at: new Date().toISOString(),
    mine: true
  })
  Object.assign(t, {
    status: 'waiting_human',
    requests: [{ id: 88, kind: 'approval', status: 'open', tool: 'publish_github', question: 'Publicar?' }]
  })
  platform.emitEvent('decision.created', { id: 88, title: 'Publicar o repositório com o modelo?', agent: 'x' })
  platform.emitEvent('task.updated', { id: 901, status: 'waiting_human' })
  const decision = card.locator('[data-decision="88"]')
  await expect(decision).toContainText('Publicar o repositório com o modelo?', { timeout: 30_000 })
  await expect(card).toContainText('decidir (1)')
  await decision.getByRole('button', { name: 'Aprovar', exact: true }).click()
  await expect.poll(() => platform.actions.map((a) => a.path)).toContain('/api/decisions/88')

  // It ends with a report and a link: both open from the card.
  platform.files.set(5, { name: 'relatorio.md', data: '# Churn\nAUC 0,91' })
  Object.assign(t, {
    status: 'done',
    requests: [],
    result: 'Modelo pronto. Código em https://github.com/exemplo/churn-model.',
    files: [{ id: 5, name: 'relatorio.md', version: 2, kind: 'output', size: 18 }]
  })
  platform.emitEvent('task.updated', { id: 901, status: 'done' })
  const files = card.locator('[data-follow-deliverables]')
  await expect(files).toContainText('relatorio.md')
  await expect(files).toContainText('v2')
  await expect(files.getByRole('link', { name: /github\.com\/exemplo\/churn-model/ })).toBeVisible()
  await files.locator('[data-task-file="5"]').getByRole('button', { name: 'Abrir' }).click()
  await expect.poll(opened).toHaveLength(1)
  const [path] = await opened()
  const slash = (p: string) => p.split('\\').join('/')
  expect(slash(path)).toBe(`${slash(downloads)}/Agent Hangar/tarefa-901/relatorio.md`)
  expect(readFileSync(path, 'utf8')).toBe('# Churn\nAUC 0,91')
  if (process.env.SHOT) await page.screenshot({ path: 'test-results/follow-phase2.png' })
})
