import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeCodex } from '../fake-codex'
import { expect, test } from './fixtures'

// The app reads the ChatGPT desktop app's data from CODEX_HOME (it inherits this process's environment).
let root: string
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hangar-e2e-codex-'))
  process.env.CODEX_HOME = makeFakeCodex(root).codex
})
test.afterAll(() => {
  delete process.env.CODEX_HOME
  rmSync(root, { recursive: true, force: true })
})

test('importa projeto e conversa do ChatGPT pelo botão da sidebar e continua com o contexto', async ({
  hangar,
  mock
}) => {
  const { page, invoke } = hangar
  await hangar.useMockProvider()

  await page.getByRole('button', { name: 'Importar projetos do ChatGPT' }).click()
  const dialog = page.getByRole('dialog', { name: 'Importar projetos do ChatGPT' })
  await expect(dialog.getByText('Site da loja')).toBeVisible()
  await expect(dialog.getByText(/com AGENTS\.md/)).toBeVisible()
  // The folder of "Antigo" is gone: it is listed but cannot be imported.
  await expect(dialog.getByLabel('Projeto Antigo')).toBeDisabled()
  await expect(dialog.getByText('Guardian review')).toHaveCount(0)

  await dialog.getByLabel('Conversa Landing page').check()
  // Picking a conversation brings its project along.
  await expect(dialog.getByLabel('Projeto Site da loja')).toBeChecked()
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click()
  await expect(page.getByText('Importado do ChatGPT: 1 projeto e 1 conversa')).toBeVisible()

  const projects = await invoke<{ name: string }[]>('store:list', 'projects')
  expect(projects.map((p) => p.name)).toContain('Site da loja')

  // The conversation opens as a session with its history.
  await page.getByText('Landing page', { exact: true }).first().click()
  await expect(page.getByText('Crie a landing page da loja')).toBeVisible()
  await expect(page.getByText('Pronto: index.html criado com a vitrine.')).toBeVisible()

  // Continuing: the model gets the ChatGPT conversation as context.
  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill('Agora adicione um rodapé')
  await composer.press('Enter')
  await expect(page.getByText(/Agora adicione um rodapé/).first()).toBeVisible()
  await expect
    .poll(() =>
      mock.requests.some(
        (r) => r.path === '/v1/messages' && JSON.stringify(r.body).includes('Pessoa: Crie a landing page da loja')
      )
    )
    .toBe(true)

  // Opening the dialog again shows both as imported.
  await page.getByRole('button', { name: 'Importar projetos do ChatGPT' }).click()
  await expect(dialog.getByLabel('Conversa Landing page')).toBeDisabled()
  await expect(dialog.getByText(/projeto já importado/).first()).toBeVisible()
})
