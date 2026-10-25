// Platform connection end to end, against the fake platform in tests/mock-platform: mode `required` blocks
// sessions → connect (OAuth loopback; the "browser" is a fetch that follows the authorize redirect) → /me →
// device registered → heartbeat → token refresh → device revoked by the admin → disconnected and notified.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startMockPlatform, MOCK_ORG, MOCK_USER, type MockPlatform } from '../mock-platform/server.ts'
import { expect, test, type Hangar } from './fixtures.ts'

interface State {
  status: string
  canCreateSessions: boolean
  user?: { email: string }
  device: { deviceId: string; status: string }
  notice?: { message: string }
  error?: string
}

let platform: MockPlatform

test.beforeEach(async () => {
  platform = await startMockPlatform({ log: process.env.MOCK_LOG ? (l) => console.log(`[platform] ${l}`) : undefined })
})
test.afterEach(async () => {
  await platform.close()
})

/** Replaces the system browser: the authorize URL is fetched and its redirect to the app's loopback followed. */
async function fakeBrowser(hangar: Hangar): Promise<void> {
  await hangar.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
}

async function openPlatformSettings(hangar: Hangar): Promise<void> {
  await hangar.page.keyboard.press('Control+,')
  await hangar.page.getByRole('button', { name: 'Plataforma', exact: true }).click()
  await expect(hangar.page.getByRole('heading', { name: 'Plataforma' })).toBeVisible()
}

test('required mode: connect, register the device, heartbeat, refresh, revoked by the admin', async ({ hangar }) => {
  const { page, invoke } = hangar
  await fakeBrowser(hangar)

  const required = await invoke<State>('platform:setConfig', { url: platform.url, mode: 'required' })
  expect(required.status).toBe('disconnected')
  expect(required.canCreateSessions).toBe(false)
  await expect(invoke('sessions:create', { cwd: hangar.work })).rejects.toThrow(/exige conexão com a plataforma/)
  // The new session view and the sidebar say so.
  await expect(page.getByRole('alert').getByRole('button', { name: 'Conectar à plataforma' })).toBeVisible()

  await openPlatformSettings(hangar)
  await page.getByRole('button', { name: 'Conectar à plataforma' }).click()
  await expect(page.getByText(MOCK_USER.name).first()).toBeVisible()
  await expect(page.getByText(MOCK_ORG.name).first()).toBeVisible()
  await expect(page.getByText('Dados', { exact: true })).toBeVisible()

  const connected = await invoke<State>('platform:state')
  expect(connected).toMatchObject({ status: 'connected', canCreateSessions: true, user: { email: MOCK_USER.email } })
  expect(connected.device.status).toBe('active')
  const device = platform.devices.get(connected.device.deviceId)
  expect(device).toMatchObject({ status: 'active', os: 'windows', heartbeats: 1 })
  expect([...platform.clients.values()][0]).toMatchObject({ softwareId: 'hangar-desktop', scope: 'app mcp' })

  // Tokens are on disk only encrypted.
  const tokensFile = readFileSync(join(hangar.userData, 'hangar-data', 'platform', 'tokens.json'), 'utf8')
  const grant = platform.grants[0]
  expect(tokensFile).not.toContain(grant.access)
  expect(tokensFile).not.toContain(grant.refresh)

  // Sessions can be created now.
  await invoke('sessions:create', { cwd: hangar.work, title: 'Com plataforma' })

  // Heartbeat (the 15-min timer does the same) and an expired access token: refreshed once, still connected.
  platform.expireAccessTokens()
  const afterRefresh = await invoke<State>('platform:refresh')
  expect(afterRefresh.status).toBe('connected')
  expect(platform.count('/oauth/token', 'refresh_token')).toBe(1)
  expect(device?.heartbeats).toBe(2)
  expect(grant.revoked).toBe(false)

  // The admin revokes the device (and its grant): the next heartbeat says `revoked`.
  platform.revokeDevice(connected.device.deviceId)
  const revoked = await invoke<State>('platform:refresh')
  expect(revoked.status).toBe('disconnected')
  expect(revoked.canCreateSessions).toBe(false)
  expect(revoked.device.status).toBe('revoked')
  expect(revoked.notice?.message).toMatch(/dispositivo foi revogado/)
  await expect(page.getByText(/Este dispositivo foi revogado na plataforma/)).toBeVisible()
  await expect(invoke('sessions:create', { cwd: hangar.work })).rejects.toThrow(/exige conexão/)
  expect(() => readFileSync(join(hangar.userData, 'hangar-data', 'platform', 'tokens.json'))).toThrow()
})

test('optional mode: connect and disconnect from settings revokes the login', async ({ hangar }) => {
  const { page, invoke } = hangar
  await fakeBrowser(hangar)
  await invoke('platform:setConfig', { url: platform.url, mode: 'optional' })
  // Optional: sessions work without a connection.
  expect((await invoke<State>('platform:state')).canCreateSessions).toBe(true)

  await openPlatformSettings(hangar)
  await page.getByRole('button', { name: 'Conectar à plataforma' }).click()
  await expect(page.getByRole('button', { name: 'Desconectar' })).toBeVisible()
  expect(platform.devices.size).toBe(1)

  await page.getByRole('button', { name: 'Desconectar' }).click() // the confirm() is accepted by the fixture
  await expect(page.getByRole('button', { name: 'Conectar à plataforma' })).toBeVisible()
  expect(platform.grants[0].revoked).toBe(true)
  expect((await invoke<State>('platform:state')).status).toBe('disconnected')
})
