import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEXT_REPLY } from '../mock-anthropic/scripts.ts'
import { expect, test } from './fixtures'

test('tela inicial', async ({ hangar }) => {
  const { page } = hangar
  await expect(page).toHaveTitle('Agent Hangar Desktop')
  // Our own title bar with the brand (the window is frameless).
  await expect(page.getByRole('banner', { name: 'Agent Hangar Desktop' })).toContainText('Agent Hangar')
  // Onboarding already done: straight to the main screen (sidebar + new session view).
  await expect(page.getByRole('button', { name: /Nova sessão/ }).first()).toBeVisible()
  await expect(page.getByText('Escolher pasta').first()).toBeVisible()
  await expect(page.getByPlaceholder(/Buscar sessões/)).toBeVisible()
})

test('cria várias sessões com nome, sem primeira mensagem', async ({ hangar }) => {
  const { page, invoke, work } = hangar
  await invoke('settings:patch', { pinnedFolders: [work] })
  const nav = page.getByRole('button', { name: /Nova sessão/ }).first()
  for (const name of ['Rascunho A', 'Rascunho B']) {
    await nav.click()
    await page.getByLabel('Nome da sessão').fill(name)
    await page.getByRole('button', { name: 'Criar sessão', exact: true }).click()
    // The session opens with its name and an empty conversation, ready for a first message later.
    await expect(page.getByPlaceholder(/Responder ao Claude/)).toBeVisible()
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  }
  const sessions = await invoke<{ title: string }[]>('store:list', 'sessions')
  expect(sessions.map((s) => s.title)).toEqual(expect.arrayContaining(['Rascunho A', 'Rascunho B']))
})

test('sessão numa pasta temporária recebe texto em streaming do mock', async ({ hangar, mock }) => {
  await hangar.useMockProvider()
  await hangar.openNewSession({ title: 'E2E Streaming' })
  const { page } = hangar
  const composer = page.getByPlaceholder(/Responder ao Claude/)
  // A long reply (8 parts, 150 ms between SSE events). In SDK mode Claude Code forwards text deltas in bursts,
  // so the reply must outlast one burst for a partial state to be visible.
  await composer.fill('[[script:text delay=150 repeat=8]] Diga olá')
  await composer.press('Enter')

  // While the stream is running only part of the reply is on screen…
  await page.waitForFunction(
    () => document.body.innerText.includes('Parte 1. ') && !document.body.innerText.includes('Parte 8. '),
    undefined,
    {
      polling: 50,
      timeout: 60_000
    }
  )
  // …and then the whole reply.
  await expect(page.getByText(`Parte 8. ${TEXT_REPLY}`)).toBeVisible({ timeout: 60_000 })

  const calls = mock.messages().filter((m) => (m.tools ?? []).length > 0)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((m) => m.stream === true)).toBe(true)
  // Every model call went to the mock with the fake token, never the user's login.
  const auth = mock.requests.filter((r) => r.path === '/v1/messages').map((r) => r.headers.authorization)
  expect(auth.every((a) => a === 'Bearer mock-token')).toBe(true)
})

test('cartão de permissão → Permitir → arquivo escrito → aparece em Artifacts', async ({ hangar }) => {
  await hangar.useMockProvider()
  const session = await hangar.openNewSession({ title: 'E2E Permissão', permissionMode: 'default' })
  const { page } = hangar
  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill('[[script:write-file path=pagina.html]] Crie uma página')
  await composer.press('Enter')

  await expect(page.getByText(/Claude quer usar/).first()).toBeVisible()
  const file = join(session.cwd, 'pagina.html')
  expect(existsSync(file)).toBe(false)
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()

  await expect(page.getByText('Pronto: pagina.html foi criado.')).toBeVisible()
  expect(readFileSync(file, 'utf8')).toContain('<h1>Criado pelo mock</h1>')

  await page.locator('header').getByRole('button', { name: 'Artifacts' }).click()
  await expect(page.getByRole('button', { name: /pagina\.html/ }).first()).toBeVisible()
  // Rendered in the sandboxed artifact frame.
  await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(1)
})
