// Agent Hangar tools in a session that was already open before the app connected: the next message restarts the
// query (resuming the conversation) with the platform's MCP server, through the app's loopback bridge.
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

test('sessão aberta antes de conectar ganha as ferramentas do Agent Hangar na mensagem seguinte', async ({
  hangar,
  mock
}) => {
  const { page, invoke, app } = hangar
  // The "browser" of the OAuth login: fetch the authorize URL and follow its redirect to the app's loopback.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  await hangar.useMockProvider()
  await hangar.openNewSession({ title: 'Antes de conectar' })

  const composer = page.getByPlaceholder(/Responder ao Claude/)
  const mentionsPlatform = () =>
    mock.requests.some((r) => r.path === '/v1/messages' && JSON.stringify(r.body).includes('list_agents'))
  await composer.fill('Primeira mensagem')
  await composer.press('Enter')
  await expect(page.getByText(TEXT_REPLY).first()).toBeVisible({ timeout: 60_000 })
  expect(mentionsPlatform()).toBe(false)

  await invoke('platform:connect')
  await expect.poll(async () => (await invoke<{ status: string }>('platform:state')).status).toBe('connected')

  await composer.fill('Segunda mensagem')
  await composer.press('Enter')
  await expect(page.getByText(/a sessão também tem as ferramentas da plataforma/)).toBeVisible()
  await expect(page.getByText(TEXT_REPLY).nth(1)).toBeVisible({ timeout: 60_000 })
  // Claude Code reached the platform's MCP server through the bridge and offered its tool to the model.
  expect(platform.mcpCalls).toEqual(expect.arrayContaining(['initialize', 'tools/list']))
  await expect.poll(mentionsPlatform).toBe(true)
  // Same conversation: the first exchange is still in what the model sees.
  const last = mock.requests.filter((r) => r.path === '/v1/messages').at(-1)
  expect(JSON.stringify(last?.body)).toContain('Primeira mensagem')
})
