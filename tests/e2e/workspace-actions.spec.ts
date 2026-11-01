// M2 of the workspace, against the fake platform: decide in Decisões, read and archive in Caixa de entrada, and
// manage an agent from Meus agentes (stop, publish, delete), all through the app's login, never the portal.
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { expect, test, type Hangar } from './fixtures.ts'

let platform: MockPlatform | undefined

test.afterEach(async () => {
  await platform?.close()
  platform = undefined
})

async function connect(hangar: Hangar, p: MockPlatform): Promise<void> {
  await hangar.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      // The OAuth login goes through (the fake platform auto-approves); anything else is only recorded.
      if (url.includes('/oauth/authorize')) void fetch(url).then((r) => r.text())
      else g.__opened!.push(url)
    }
  })
  await hangar.invoke('platform:setConfig', { url: p.url, mode: 'optional' })
  expect((await hangar.invoke<{ status: string }>('platform:connect')).status).toBe('connected')
}

const opened = (hangar: Hangar) => hangar.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

test('workspace M2: decidir, caixa de entrada e gerenciar um agente pelo app', async ({ hangar }) => {
  platform = await startMockPlatform({ log: process.env.MOCK_LOG ? (l) => console.log(`[platform] ${l}`) : undefined })
  const { page } = hangar
  await connect(hangar, platform)
  const nav = page.getByRole('region', { name: 'Agent Hangar' })
  const decisionsBadge = nav.locator('[data-badge="Decisões"]')
  await expect(decisionsBadge).toHaveText('1')

  // Decisões: the approval card with its action; approving it removes it and the badge.
  await nav.getByRole('button', { name: /^Decisões/ }).click()
  const card = page.locator('[data-decision="77"]')
  await expect(card).toContainText('Enviar o relatório para a diretoria?')
  await expect(card).toContainText('Ação: send_email')
  await card.getByLabel('Comentário da decisão 77').fill('Pode enviar.')
  await card.getByRole('button', { name: 'Aprovar', exact: true }).click()
  await expect
    .poll(() => platform!.actions.map((a) => [a.path, a.body.decision, a.body.reason]))
    .toEqual([['/api/decisions/77', 'approve', 'Pode enviar.']])
  await expect(page.locator('[data-decision="77"]')).toHaveCount(0)
  await expect(decisionsBadge).toHaveCount(0)
  // The notice is still there, with "Ciente".
  await expect(page.locator('[data-decision="78"]').getByRole('button', { name: 'Ciente' })).toBeVisible()

  // Caixa de entrada: the task the person asked for; mark it read, then archive it.
  await nav.getByRole('button', { name: /^Caixa de entrada/ }).click()
  const row = page.locator('[data-inbox="task:501"]')
  await expect(row).toContainText('Relatório de vendas de outubro')
  await row.getByRole('button', { name: 'Marcar como lida' }).click()
  await expect(row.getByRole('button', { name: 'Marcar como não lida' })).toBeVisible()
  await row.getByRole('button', { name: 'Arquivar' }).click()
  await expect(page.locator('[data-inbox="task:501"]')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Arquivadas' }).click()
  await expect(page.locator('[data-inbox="task:501"]')).toBeVisible()
  expect(platform.actions.filter((a) => a.path === '/api/inbox/mark').map((a) => a.body)).toEqual([
    { keys: ['task:501'], read: true },
    { keys: ['task:501'], archived: true }
  ])

  // Meus agentes → Gerenciar: versions, where it runs, and the actions the person's permissions allow.
  await nav.getByRole('button', { name: /^Meus agentes/ }).click()
  const agent = page.locator('[data-agent="resumo-diario"]')
  await agent.getByRole('button', { name: 'Gerenciar' }).click()
  const panel = page.locator('[data-manage="resumo-diario"]')
  await expect(panel).toContainText('Produção: v3 no ar')
  await expect(panel).toContainText('Último teste (v3): passed · 10/10')
  await panel.getByRole('button', { name: 'Parar produção' }).click() // confirm() is accepted by the fixture
  await expect(panel).toContainText('Parado em produção.')
  await expect(panel).toContainText('Produção: parado')
  await panel.getByRole('button', { name: 'Testar e publicar' }).click()
  await expect(panel).toContainText('Testado e publicado em produção.')
  await panel.getByRole('button', { name: 'Excluir' }).click()
  await expect(page.locator('[data-agent="resumo-diario"]')).toHaveCount(0)
  expect(platform.actions.filter((a) => a.path.startsWith('/api/agents/')).map((a) => [a.method, a.path])).toEqual([
    ['POST', '/api/agents/resumo-diario/stop'],
    ['POST', '/api/agents/resumo-diario/ship'],
    ['DELETE', '/api/agents/resumo-diario']
  ])

  // A Digital employee: pause from the panel.
  const employee = page.locator('[data-agent="analista-dados"]')
  await employee.getByRole('button', { name: 'Gerenciar' }).click()
  await expect(page.locator('[data-manage="analista-dados"]').getByRole('button', { name: 'Pausar' })).toBeVisible()

  // Nothing of this went through the portal.
  expect(await opened(hangar)).toEqual([])

  // "Trabalhar no VS Code": the extension's link, built by the app from the slug and the connected platform.
  await employee.getByRole('button', { name: 'Trabalhar no VS Code' }).click()
  await expect
    .poll(() => opened(hangar))
    .toEqual([
      `vscode://agent-hangar.agent-hangar/work?${new URLSearchParams({ employee: 'analista-dados', url: platform.url }).toString()}`
    ])
})
