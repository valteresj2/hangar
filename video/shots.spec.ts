// Screens of the real app for the product video, captured against the fake servers (tests/mock-*):
// the main screen, a session that writes a file with tools, providers, the platform workspace and Sobre.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startMockPlatform } from '../tests/mock-platform/server.ts'
import { expect, REPO_ROOT, test } from '../tests/e2e/fixtures.ts'

const OUT = join(REPO_ROOT, 'video', 'shots')
mkdirSync(OUT, { recursive: true })

test('product video screens', async ({ hangar }) => {
  const { page, invoke, app } = hangar
  const win = await app.browserWindow(page)
  await win.evaluate((w) => w.setSize(1600, 1000))
  await page.waitForTimeout(400)
  const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`) })

  await shot('01-home')

  // A session that builds something with tools (the fake model writes a page).
  await hangar.useMockProvider({ name: 'Claude (via gateway)' })
  await hangar.openNewSession({ title: 'Landing page do produto', permissionMode: 'acceptEdits' })
  const composer = page.getByPlaceholder(/Responder ao Claude/)
  await composer.fill('[[script:write-file path=landing.html]] Crie uma landing page para o lançamento do produto')
  await composer.press('Enter')
  // The fake model's script marker and the temp folder are test plumbing: shown as a real project would look.
  const tidy = () =>
    page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        n.textContent = (n.textContent ?? '')
          .replace(/\[\[script:[^\]]*\]\]\s*/g, '')
          .replace(/(…\/)?[^\s]*hangar-e2e-[A-Za-z0-9]+[\\/]work[\\/]/g, '~/projetos/site/')
          .replace(/Claude requested permissions to write to .*/, 'Aprove uma vez ou sempre para esta sessão.')
          .replace('<title>Mock</title>', '<title>Lançamento</title>')
          .replace('Criado pelo mock', 'Lançamento 2026')
      }
    })
  const allow = page.getByRole('button', { name: 'Permitir', exact: true })
  await expect(allow).toBeVisible({ timeout: 60_000 })
  await tidy()
  await page.waitForTimeout(400)
  await shot('02-permission')
  await allow.click()
  await expect(page.getByText(/Pronto: landing.html foi criado/)).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(800)
  await tidy()
  await shot('02-session')
  await page.getByRole('button', { name: 'Arquivos', exact: true }).click()
  await page.getByText('landing.html', { exact: true }).last().click()
  await page.waitForTimeout(1200)
  await tidy()
  await shot('03-session-panel')
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.waitForTimeout(2500)
  // The machine's own shell start-up output (profile messages, user paths) is not the product: a neutral prompt, a
  // cleared screen and a command that shows the file the agent wrote.
  await page.locator('.xterm-helper-textarea').first().focus()
  const shell =
    process.platform === 'win32'
      ? "function prompt { 'PS ~/projetos/site> ' }; cls; Get-ChildItem -Name; Get-Content landing.html"
      : "PS1='~/projetos/site $ '; clear; ls; cat landing.html"
  await page.keyboard.type(shell)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await tidy()
  await shot('04-session-terminal')
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()

  // Providers: Claude subscription, gateways for any model, with the compat layer.
  await invoke('settings:providerSave', {
    name: 'LiteLLM (GPT, Qwen, DeepSeek…)',
    kind: 'gateway',
    baseUrl: 'http://localhost:4000',
    authStyle: 'bearer',
    models: {
      default: 'openrouter/openai/gpt-4.1-mini',
      extra: ['openrouter/qwen/qwen3-coder', 'openrouter/deepseek/deepseek-v4.1-flash']
    }
  })
  await page.keyboard.press('Control+Comma')
  await page.getByText('Provedores', { exact: true }).first().click()
  await page.waitForTimeout(800)
  await shot('05-providers')
  await page.keyboard.press('Escape')

  // The platform: connect, Início and Meus agentes.
  const platform = await startMockPlatform({ keepaliveMs: 1_000 })
  try {
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        void fetch(url).then((r) => r.text())
      }
    })
    await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
    await invoke('platform:connect')
    const nav = page.getByRole('region', { name: 'Agent Hangar' })
    await nav.getByRole('button', { name: 'Início', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Ana$/ })).toBeVisible()
    await page.waitForTimeout(800)
    await shot('06-workspace-home')
    await nav.getByRole('button', { name: /^Meus agentes/ }).click()
    await page.waitForTimeout(1000)
    await shot('07-workspace-agents')
  } finally {
    await platform.close()
  }
})
