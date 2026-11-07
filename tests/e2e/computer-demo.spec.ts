// Opt-in live demo (HANGAR_COMPUTER_DEMO=1, Windows): the real app with the REAL Windows driver operates a tiny
// WinForms "Mini ERP" (tests/computer/MiniErp.cs, compiled on the fly), with the mock platform and a scripted
// employee, paced so a person can watch: the panel turns the workstation on, the indicator appears, the employee opens
// the app, fills the invoice, types the password from the vault into the password field, "Lançar" waits for the
// approval (with the screenshot), runs after it, the "Sim" of the confirmation is covered, and Parar stops the next
// task. It moves the mouse and types: touching the computer pauses it, as designed.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { call, mockWorkstation, say, type MockWorkstation } from '../mock-platform/workstation.ts'
import { expect, test } from './fixtures.ts'

const DEMO = process.env.HANGAR_COMPUTER_DEMO === '1' && process.platform === 'win32'
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const PACE_MS = Number(process.env.HANGAR_COMPUTER_DEMO_PACE ?? 1200)

test.skip(!DEMO, 'HANGAR_COMPUTER_DEMO=1 (Windows) not set')

let platform: MockPlatform
let ws: MockWorkstation

test.beforeEach(async () => {
  ws = mockWorkstation()
  platform = await startMockPlatform({ extraRoutes: (req, res, ctx) => ws.routes(req, res, ctx) })
})
test.afterEach(async () => {
  await platform.close()
  try {
    execFileSync('taskkill', ['/IM', 'MiniErp.exe', '/F'], { stdio: 'ignore' })
  } catch {
    /* closed */
  }
})

type Msg = { role: string; content?: unknown }
const lastTool = (b: { messages: unknown[] }): string => {
  const m = [...(b.messages as Msg[])].reverse().find((x) => x.role === 'tool')
  return typeof m?.content === 'string' ? m.content : ''
}
const el = (b: { messages: unknown[] }, type: string, name: string): string => {
  const m = new RegExp(`\\[(\\d+)\\] ${type} "${name}"`).exec(lastTool(b))
  if (!m) throw new Error(`sem ${type} "${name}" na tela:\n${lastTool(b)}`)
  return m[1]
}
const paced = (f: (b: { messages: unknown[] }) => object[]) => async (b: { messages: unknown[] }) => {
  await new Promise((r) => setTimeout(r, PACE_MS))
  return f(b)
}

test('demo: um funcionário lança uma fatura no Mini ERP deste computador', async ({ hangar }, testInfo) => {
  test.setTimeout(240_000)
  const { page, invoke, app } = hangar
  const dir = mkdtempSync(join(tmpdir(), 'hangar-demo-'))
  const exe = join(dir, 'MiniErp.exe')
  const log = join(dir, 'lancamentos.log')
  execFileSync(CSC, [
    '-nologo',
    '-target:winexe',
    `-out:${exe}`,
    '-r:System.Windows.Forms.dll',
    '-r:System.Drawing.dll',
    resolve('tests/computer/MiniErp.cs')
  ])
  spawn(exe, [log], { detached: true, stdio: 'ignore' }).unref()

  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  await invoke('platform:connect')
  await expect.poll(async () => (await invoke<{ status: string }>('platform:state')).status).toBe('connected')

  ws.secrets = { 'erp-senha': 's3nh4-demo' }
  ws.gate = (tool, args) => (tool === 'desktop:click' && args.label === 'Lançar' ? 'waiting' : 'allowed')
  const task = ws.addTask({
    id: 701,
    title: 'Lançar a fatura 88',
    body: 'Lance a fatura 88, de R$ 1.500,00, no Mini ERP.',
    rounds: [
      paced(() => [...say('Vou abrir o Mini ERP.'), ...call('c1', 'desktop_open', { app: 'Mini ERP' })]),
      paced((b) => call('c2', 'desktop_type', { text: '88', label: 'Fatura', element: el(b, 'edit', 'Fatura') })),
      paced((b) => call('c3', 'desktop_type', { text: '1500,00', label: 'Valor', element: el(b, 'edit', 'Valor') })),
      paced((b) =>
        call('c4', 'desktop_type', { text: 'secret://erp-senha', label: 'Senha', element: el(b, 'edit', 'Senha') })
      ),
      paced((b) => call('c5', 'desktop_click', { label: 'Lançar', element: el(b, 'button', 'Lançar') })),
      paced((b) => call('c6', 'desktop_click', { label: 'Sim', element: el(b, 'button', 'Sim') })),
      paced(() => say('Fatura 88 lançada no Mini ERP (R$ 1.500,00).'))
    ]
  })

  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Posto no computador', exact: true }).click()
  await page.getByTestId('computer-employee').selectOption('assistente-adm')
  await page.getByTestId('computer-apps').last().getByPlaceholder('Procurar app…').fill('mini')
  await page
    .getByTestId('computer-apps')
    .last()
    .getByLabel(/Mini ERP/)
    .first()
    .check()
  await invoke('computer:setResumeAfter', 3)
  await page.getByRole('button', { name: 'Ligar neste computador' }).click()

  // "Lançar" waits for the person's approval, with the screenshot.
  await expect.poll(() => ws.requests.length, { timeout: 120_000 }).toBe(1)
  expect(ws.requests[0]).toMatchObject({ tool: 'desktop:click', screenshot: true, args: { label: 'Lançar' } })
  expect(existsSync(log)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('1-aguardando-aprovacao.png') })
  await new Promise((r) => setTimeout(r, 3000))
  ws.decide(ws.requests[0].id, 'approve')

  await expect.poll(() => task.status, { timeout: 120_000 }).toBe('done')
  expect(readFileSync(log, 'utf8')).toMatch(/fatura=88\tvalor=1500,00\tsenha_ok=sim/)
  expect(JSON.stringify(task.gates)).not.toContain('s3nh4')
  expect(JSON.stringify(task.progress)).not.toContain('s3nh4')
  await page.screenshot({ path: testInfo.outputPath('2-lancada.png') })

  // Parar: the next task stops at once and goes back to the platform.
  let go!: () => void
  const held = new Promise<void>((r) => (go = r))
  const t2 = ws.addTask({
    id: 702,
    title: 'Lançar a fatura 89',
    body: 'Lance a fatura 89.',
    rounds: [
      async () => {
        await held
        return call('d1', 'desktop_open', { app: 'Mini ERP' })
      }
    ]
  })
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'working', { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 2000))
  await page.getByRole('button', { name: /^Parar/ }).click()
  go()
  await expect(page.getByTestId('computer-status')).toHaveAttribute('data-status', 'stopped')
  await expect.poll(() => t2.results.at(-1)?.status, { timeout: 15_000 }).toBe('waiting')
  await page.screenshot({ path: testInfo.outputPath('3-parado.png') })
  console.log(`[demo] lançamentos: ${readFileSync(log, 'utf8').trim()}`)
  console.log(
    `[demo] linha do tempo (passos): ${task.progress
      .map((p) => (p.tool as { name?: string } | undefined)?.name)
      .filter(Boolean)
      .join(', ')}`
  )
})
