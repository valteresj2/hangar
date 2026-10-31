// The member's workspace end to end (docs/platform/m1-contract.md), against the fake platform in
// tests/mock-platform: connect → the "Agent Hangar" section and Início with the member's data → a decision.created
// event moves the badge live → a `hangar://open/workspace/agents` link (a real second launch of the app) opens
// Meus agentes → links not migrated yet open the portal → the stream reconnects with Last-Event-ID → disconnect.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { expect, REPO_ROOT, test, type Hangar } from './fixtures.ts'

const electronExe = createRequire(import.meta.url)('electron') as unknown as string

let platform: MockPlatform | undefined

test.afterEach(async () => {
  await platform?.close()
  platform = undefined
})

async function connect(hangar: Hangar, p: MockPlatform): Promise<void> {
  // The "browser" of the OAuth login: follows the authorize URL (the fake platform auto-approves).
  await hangar.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await hangar.invoke('platform:setConfig', { url: p.url, mode: 'optional' })
  const state = await hangar.invoke<{ status: string }>('platform:connect')
  expect(state.status).toBe('connected')
  // From here on the browser only records what the app opens.
  await hangar.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened!.push(url)
    }
  })
}

const opened = (hangar: Hangar) => hangar.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

/** Launches the app again with a link, like Windows does for `hangar://` (the running instance gets it). */
async function launchWithLink(hangar: Hangar, link: string): Promise<number | null> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  const child = spawn(electronExe, [REPO_ROOT, `--user-data-dir=${hangar.userData}`, link], {
    cwd: REPO_ROOT,
    env: { ...env, HANGAR_E2E: '1' },
    stdio: 'ignore'
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the second instance did not quit'))
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

test('workspace: Início with live badges, deep link to Meus agentes, portal links, reconnection', async ({
  hangar
}) => {
  const { page, invoke } = hangar
  platform = await startMockPlatform({ keepaliveMs: 1_000 })

  // Before connecting: the section offers the connection.
  const nav = page.getByRole('region', { name: 'Agent Hangar' })
  await expect(nav.getByRole('button', { name: 'Conecte à plataforma' })).toBeVisible()

  await connect(hangar, platform)
  const decisionsBadge = nav.locator('[data-badge="Decisões"]')
  const inboxBadge = nav.locator('[data-badge="Caixa de entrada"]')
  await expect(decisionsBadge).toHaveText('1')
  await expect(inboxBadge).toHaveText('2')
  await expect.poll(() => platform!.streams()).toBe(1)
  await expect(nav.getByLabel(/Ao vivo/)).toBeVisible()

  // Início, native, with the member's data.
  await nav.getByRole('button', { name: 'Início', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: /^(Bom dia|Boa tarde|Boa noite), Ana$/ })).toBeVisible()
  await expect(page.getByRole('main').getByText('Acme Ltda', { exact: true })).toBeVisible()
  const kpi = (label: string) => page.locator(`[data-kpi="${label}"]`)
  await expect(kpi('Para você decidir')).toContainText('1')
  await expect(kpi('Meus agentes')).toContainText('3')
  await expect(kpi('Trabalhando agora')).toContainText('1')
  await expect(kpi('Custo no mês')).toContainText('US$ 12,34')
  await expect(page.getByRole('button', { name: /Analista de Dados · aprovação/ })).toBeVisible()
  await expect(page.getByText('Trabalhando em: Relatório de vendas de outubro').first()).toBeVisible()
  // A notice informs, it does not wait for a decision.
  await expect(page.getByText(/Fila do suporte normalizada/)).toHaveCount(0)

  // A decision is created on the platform: the badge moves without a reload.
  const before = platform.count('/api/decisions')
  platform.addDecision({ id: 90, title: 'Publicar o painel de vendas?' })
  await expect(decisionsBadge).toHaveText('2')
  await expect(inboxBadge).toHaveText('3')
  await expect(kpi('Para você decidir')).toContainText('2')
  await expect(page.getByText(/Publicar o painel de vendas\?/)).toBeVisible()
  // … and the details are fetched once after the burst of events.
  await expect.poll(() => platform!.count('/api/decisions')).toBe(before + 1)

  // Opening an agent from the app: the portal (until M3) and "Vistos recentemente".
  await page
    .getByRole('button', { name: /Analista de Dados$/ })
    .first()
    .click()
  await expect.poll(() => opened(hangar)).toContain(`${platform.url}/app#/employees/analista-dados`)
  const recent = page.locator('[data-card="recent"]')
  await expect(recent.getByRole('button', { name: 'Analista de Dados' })).toBeVisible()

  // Decisões and Caixa de entrada open the portal (until M2).
  await nav.getByRole('button', { name: /^Decisões/ }).click()
  await nav.getByRole('button', { name: /^Caixa de entrada/ }).click()
  await expect
    .poll(() => opened(hangar))
    .toEqual(expect.arrayContaining([`${platform.url}/app#/decisions`, `${platform.url}/app#/inbox`]))

  // A deep link from outside: a second launch hands it to this instance, which shows Meus agentes.
  await page
    .getByRole('button', { name: /^Nova sessão/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: /Ana$/ })).toHaveCount(0)
  expect(await launchWithLink(hangar, 'hangar://open/workspace/agents')).toBe(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Meus agentes' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Meus agentes' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: /Pessoais \(1\)/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Do time, que eu gerencio \(1\)/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Agentes que eu criei ou mantenho \(1\)/ })).toBeVisible()
  const analyst = page.locator('[data-agent="analista-dados"]')
  await expect(analyst).toContainText('Digital employee')
  await expect(analyst).toContainText('claude-sonnet-4-5')
  await expect(analyst).toContainText('harness claude-code')
  await expect(analyst).toContainText('Pleno')
  await expect(analyst).toContainText('Último uso: agora')
  const built = page.locator('[data-agent="resumo-diario"]')
  await expect(built).toContainText('Agente')
  await expect(built).toContainText('Em produção')
  await expect(built).toContainText('você criou')

  // "Conversar": a new session filled in to talk to the agent (name and first message, both editable).
  await built.getByRole('button', { name: 'Conversar' }).click()
  await expect(page.getByLabel('Nome da sessão')).toHaveValue(/^Conversa · /)
  await expect(page.getByPlaceholder(/Descreva a tarefa/)).toHaveValue(/\(resumo-diario\) do Agent Hangar/)
  await nav.getByRole('button', { name: /^Meus agentes/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Meus agentes' })).toBeVisible()

  // An agent's status changes on the platform: the list follows.
  platform.emitEvent('agent.status', { slug: 'suporte-n1', status: 'paused' })
  await expect(page.locator('[data-agent="suporte-n1"]')).toContainText('Pausado')

  // Links outside the closed list do nothing; routes not migrated open the portal.
  const count = (await opened(hangar)).length
  expect(await launchWithLink(hangar, 'hangar://open/../../settings')).toBe(0)
  expect(await launchWithLink(hangar, 'hangar://open/agents/https:evil')).toBe(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Meus agentes' })).toBeVisible()
  expect(await launchWithLink(hangar, 'hangar://open/decisions/90')).toBe(0)
  await expect.poll(async () => (await opened(hangar)).slice(count)).toEqual([`${platform.url}/app#/decisions`])

  // The stream drops: the app reconnects, resuming after the last event it saw.
  const lastId = String(platform.events.at(-1)!.id)
  platform.dropStreams()
  await expect.poll(() => platform!.eventResumes.at(-1), { timeout: 15_000 }).toBe(lastId)
  await expect.poll(() => platform!.streams()).toBe(1)
  platform.emitEvent('inbox.changed', { unread: 7 })
  await expect(inboxBadge).toHaveText('7')

  // Disconnected: nothing of the person stays, the section offers the connection again.
  await invoke('platform:disconnect')
  await expect(nav.getByRole('button', { name: 'Conecte à plataforma' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Conecte à plataforma' })).toBeVisible()
  expect((await invoke<{ connected: boolean; home: { data?: unknown } }>('workspace:state')).home.data).toBeUndefined()
})

test('workspace: an older platform without events falls back to polling; cache shows while offline', async ({
  hangar
}) => {
  const { page, invoke } = hangar
  platform = await startMockPlatform()
  platform.setEventsEnabled(false)
  await connect(hangar, platform)
  const nav = page.getByRole('region', { name: 'Agent Hangar' })
  await expect(nav.getByLabel(/atualizando a cada 60 s/)).toBeVisible()
  await nav.getByRole('button', { name: 'Início', exact: true }).click()
  await expect(page.getByRole('main').getByText('Acme Ltda', { exact: true })).toBeVisible()

  // The platform stops answering: the cached Início stays, with the error and "Tentar de novo".
  await platform.close()
  platform = undefined
  await invoke('workspace:refresh', 'home')
  await expect(page.getByText(/Não foi possível conectar a 127\.0\.0\.1/)).toBeVisible()
  await expect(page.getByRole('main').getByText('Acme Ltda', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible()
})
