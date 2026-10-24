import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, REPO_ROOT, test } from './fixtures'

test('Terminal abre na pasta da sessão e mostra o prompt', async ({ hangar }) => {
  await hangar.useMockProvider()
  await hangar.openNewSession({ title: 'E2E Terminal' })
  const { page } = hangar
  await page.locator('header').getByRole('button', { name: 'Terminal' }).click()

  const rows = page.locator('.xterm-rows').first()
  // PowerShell ("PS C:\…>"), cmd ("C:\…>") or a POSIX shell ("$ ").
  await expect.poll(async () => (await rows.innerText()).trim(), { timeout: 30_000 }).toMatch(/(PS [A-Za-z]:\\.*>|[A-Za-z]:\\.*>|[$#] ?$)/m)

  await page.locator('.xterm').first().click()
  await page.keyboard.type('echo hangar-e2e-ok')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await rows.innerText()).split('hangar-e2e-ok').length - 1, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
})

test('Motion de exemplo toca no player', async ({ hangar }) => {
  await hangar.useMockProvider()
  const session = await hangar.openNewSession({ title: 'E2E Motion' })
  const file = join(session.cwd, 'example.motion.json')
  copyFileSync(join(REPO_ROOT, 'docs', 'motion', 'example.motion.json'), file)
  const { page } = hangar

  // The same path the chat's "Abrir no player" button takes: open Artifacts and dispatch the open event.
  await page.locator('header').getByRole('button', { name: 'Artifacts' }).click()
  await page.evaluate((path) => window.dispatchEvent(new CustomEvent('hangar:artifacts:open', { detail: { path } })), file)

  await expect(page.locator('canvas').first()).toBeVisible()
  const clock = page.getByText(/^\d+:\d\d\.\d \/ 0:12\.0$/)
  await expect(clock).toHaveText('0:00.0 / 0:12.0')
  await expect(page.getByRole('button', { name: 'Números' })).toBeVisible()

  await page.getByTitle('Tocar (Espaço)').click()
  await expect.poll(async () => Number((await clock.innerText()).split(' / ')[0].split(':')[1]), { timeout: 10_000 }).toBeGreaterThan(1)
  await page.getByTitle('Pausar (Espaço)').click()

  // The canvas actually draws the spec (background #faf9f5 at a corner).
  const pixel = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement
    return [...c.getContext('2d')!.getImageData(2, 2, 1, 1).data.slice(0, 3)]
  })
  expect(pixel).toEqual([250, 249, 245])
})

test('teste de conexão de um perfil com o mock devolvendo 401', async ({ hangar, mock }) => {
  const token = 'mock-token-401'
  await hangar.useMockProvider({ name: 'Gateway 401', token, makeDefault: false })
  const { page } = hangar
  await page.getByTitle('Configurações').click()
  await page.getByRole('button', { name: 'Provedores', exact: true }).click()

  // The profile row: the innermost block that starts with the profile name and has its own "Testar" button.
  const item = page
    .locator('div')
    .filter({ hasText: /^Gateway 401/ })
    .filter({ has: page.getByRole('button', { name: 'Testar' }) })
    .last()
  await item.getByRole('button', { name: 'Testar' }).click()
  const failure = item.getByText(/^✗/)
  await expect(failure).toBeVisible({ timeout: 90_000 })
  const text = await failure.innerText()
  test.info().annotations.push({ type: 'erro mostrado', description: text })
  expect(text).toMatch(/HTTP 401/)
  expect(text).not.toContain(token)
  // The test really went to the mock, with the profile's token.
  expect(mock.requests.some((r) => r.path === '/v1/messages' && r.headers.authorization === `Bearer ${token}`)).toBe(true)
})
