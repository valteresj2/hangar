// Synced token models end to end (docs/platform/app-api-models.md), against the fake platform in
// tests/mock-platform whose LLM proxy forwards to tests/mock-anthropic: sync → managed profile (read-only) → pick a
// token model in the composer's single picker → streamed answer through the proxy (the app sends the device key,
// the proxy the connection's credential) → key rotated after a 401 → the admin stops syncing → the profile goes and
// the session falls back to the subscription with a note → disconnect removes the profiles.
import { TEXT_REPLY } from '../mock-anthropic/scripts.ts'
import { startMockPlatform, type MockPlatform } from '../mock-platform/server.ts'
import { expect, MOCK_TOKEN, test, type Hangar } from './fixtures.ts'

interface State {
  status: string
  models: {
    status: string
    error?: string
    connections: { id: number; name: string; profileId: string; models: { id: string }[] }[]
  }
}
interface Profile {
  id: string
  name: string
  managedBy?: string
  baseUrl?: string
  hasSecret: boolean
}
interface SessionRow {
  id: string
  providerId?: string
  model?: string
}

let platform: MockPlatform | undefined

test.afterEach(async () => {
  await platform?.close()
  platform = undefined
})

async function connect(hangar: Hangar, p: MockPlatform): Promise<State> {
  await hangar.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      void fetch(url).then((r) => r.text())
    }
  })
  await hangar.invoke('platform:setConfig', { url: p.url, mode: 'optional' })
  return hangar.invoke<State>('platform:connect')
}

const managed = async (hangar: Hangar) =>
  (await hangar.invoke<Profile[]>('engine:providers')).filter((p) => p.managedBy === 'platform')

test('token models: sync, pick in the composer, stream through the proxy, sync off falls back', async ({
  hangar,
  mock
}) => {
  const { page, invoke } = hangar
  platform = await startMockPlatform({
    upstream: { url: mock.url, token: MOCK_TOKEN },
    log: process.env.MOCK_LOG ? (l) => console.log(`[platform] ${l}`) : undefined
  })
  platform.setSync(11, true)
  platform.setSync(12, true) // protocol "openai": never offered to the app

  const state = await connect(hangar, platform)
  expect(state.status).toBe('connected')
  expect(state.models.status).toBe('ok')
  expect(state.models.connections.map((c) => [c.name, c.models.map((m) => m.id)])).toEqual([
    ['Anthropic Acme', ['claude-sonnet-4-5', 'claude-haiku-4-5']]
  ])
  // One device key, stored as the managed profile's secret (never shown).
  expect(platform.llmKeys.size).toBe(1)
  const [profile] = await managed(hangar)
  expect(profile).toMatchObject({
    id: 'platform-11',
    name: 'Plataforma · Anthropic Acme',
    baseUrl: `${platform.url}/api/app/llm/11`,
    hasSecret: true
  })
  expect(JSON.stringify(await invoke('settings:providersList'))).not.toContain([...platform.llmKeys.keys()][0])

  // Read-only in Configurações → Provedores; summary in Configurações → Plataforma.
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Provedores', exact: true }).first().click()
  const item = page.locator('div', { hasText: /^Plataforma · Anthropic Acme/ }).first()
  await expect(page.getByText('gerenciado pela plataforma')).toBeVisible()
  await expect(item.getByRole('button', { name: 'Editar' })).toHaveCount(0)
  await expect(invoke('settings:providerDelete', 'platform-11')).rejects.toThrow(/gerenciado pela plataforma/)
  await page.getByRole('button', { name: 'Plataforma', exact: true }).click()
  await expect(page.getByText('1 conexão sincronizada · 2 modelos')).toBeVisible()
  await page.keyboard.press('Escape')

  // The composer's single picker: Assinatura / Modelos de token · Anthropic Acme.
  const session = await hangar.openNewSession({ title: 'E2E Modelos de token' })
  const picker = page.getByLabel('Modelo', { exact: true })
  await expect(picker.locator('optgroup[label="Modelos de token · Anthropic Acme"] option')).toHaveCount(2)
  await expect(picker.locator('optgroup[label="Assinatura"] option').first()).toHaveText('Opus')
  await picker.selectOption({ label: 'Claude Haiku 4.5 · 200k · US$ 1 / 5 por 1M' })
  await expect
    .poll(async () => await invoke<SessionRow>('store:get', 'sessions', session.id))
    .toMatchObject({ providerId: 'platform-11', model: 'claude-haiku-4-5' })

  const composer = page.getByPlaceholder(/Responder ao Claude/)
  // A long reply, slow enough that a partial state shows: the proxy forwards SSE as it comes (no buffering).
  await composer.fill('[[script:text delay=150 repeat=8]] Olá pelos modelos de token')
  await composer.press('Enter')
  await page.waitForFunction(
    () => document.body.innerText.includes('Parte 1. ') && !document.body.innerText.includes('Parte 8. '),
    undefined,
    { polling: 50, timeout: 60_000 }
  )
  await expect(page.getByText(`Parte 8. ${TEXT_REPLY}`)).toBeVisible({ timeout: 60_000 })
  // Footer: origin and estimated cost.
  await expect(page.getByText(/claude-haiku-4-5 · Token · Anthropic Acme/)).toBeVisible()
  await expect(page.getByText(/US\$ [\d,]+ \(estimado\)/)).toBeVisible()

  // Every model call went app → proxy (device key) → mock (the connection's credential).
  const viaProxy = platform.proxied.filter((r) => r.path.startsWith('/v1/messages') && r.status === 200)
  expect(viaProxy.length).toBeGreaterThan(0)
  expect(viaProxy.every((r) => r.model && ['claude-haiku-4-5', 'claude-sonnet-4-5'].includes(r.model))).toBe(true)
  expect(viaProxy.some((r) => r.model === 'claude-haiku-4-5')).toBe(true)
  const upstream = mock.requests.filter((r) => r.path === '/v1/messages')
  expect(upstream.length).toBe(viaProxy.filter((r) => r.path === '/v1/messages').length)
  expect(upstream.every((r) => r.headers.authorization === `Bearer ${MOCK_TOKEN}`)).toBe(true)
  expect(platform.proxied.some((r) => r.status === 400)).toBe(false)

  // The proxy stops accepting the key (e.g. rotated elsewhere): the next sync sees the 401 and rotates it once.
  platform.invalidateLlmKeys()
  const rotated = await invoke<State>('platform:syncModels')
  expect(rotated.models.status).toBe('ok')
  expect(platform.llmKeys.size).toBe(1)
  expect(platform.count('/api/app/devices/' + (await deviceId(hangar)) + '/llm-key')).toBe(2)
  const answered = () => platform!.proxied.filter((r) => r.path.startsWith('/v1/messages') && r.status === 200).length
  const before = answered()
  await composer.fill('[[script:text]] De novo, com a chave nova')
  await composer.press('Enter')
  await expect.poll(answered, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect
    .poll(async () => (await invoke<{ status: string }>('store:get', 'sessions', session.id)).status, {
      timeout: 60_000
    })
    .toBe('idle')
  expect(platform.proxied.filter((r) => r.status === 401 && r.path.startsWith('/v1/messages'))).toHaveLength(0)

  // The admin stops syncing the connection: profile gone, session on the subscription with a note.
  platform.setSync(11, false)
  const off = await invoke<State>('platform:syncModels')
  expect(off.models.connections).toEqual([])
  expect(await managed(hangar)).toEqual([])
  const fallen = await invoke<SessionRow>('store:get', 'sessions', session.id)
  expect(fallen.providerId).toBe('subscription')
  expect(fallen.model).toBeUndefined()
  await expect(page.getByText(/Os modelos de token de “Anthropic Acme” não estão mais disponíveis/)).toBeVisible()
  await expect(picker).toHaveValue('subscription\u0001opus')
  await expect(picker.locator('optgroup[label^="Modelos de token"]')).toHaveCount(0)

  // Synced again, then disconnected: the profile goes with the login.
  platform.setSync(11, true)
  expect((await invoke<State>('platform:syncModels')).models.connections).toHaveLength(1)
  expect(await managed(hangar)).toHaveLength(1)
  await invoke('platform:disconnect')
  expect(await managed(hangar)).toEqual([])
})

test('new session and Configurações → Geral use the same picker (token model as the default)', async ({
  hangar,
  mock
}) => {
  const { page, invoke } = hangar
  platform = await startMockPlatform({ upstream: { url: mock.url, token: MOCK_TOKEN } })
  platform.setSync(11, true)
  await connect(hangar, platform)

  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Geral', exact: true }).first().click()
  const defaults = page.getByLabel('Modelo', { exact: true })
  await defaults.selectOption({ label: 'Claude Sonnet 4.5 · 200k · US$ 3 / 15 por 1M' })
  await expect
    .poll(async () => await invoke<{ defaultProviderId: string; defaultModel: string }>('settings:get'))
    .toMatchObject({ defaultProviderId: 'platform-11', defaultModel: 'claude-sonnet-4-5' })
  await page.keyboard.press('Escape')

  // The new session view starts on the default and offers the same groups.
  const picker = page.getByLabel('Modelo', { exact: true })
  await expect(picker).toHaveValue('platform-11\u0001claude-sonnet-4-5')
  await expect(picker.locator('optgroup[label="Modelos de token · Anthropic Acme"] option')).toHaveCount(2)

  // Disconnecting resets the default to the subscription (and its default model).
  await invoke('platform:disconnect')
  await expect
    .poll(async () => await invoke<{ defaultProviderId: string; defaultModel: string }>('settings:get'))
    .toMatchObject({ defaultProviderId: 'subscription', defaultModel: 'opus' })
  await expect(picker).toHaveValue('subscription\u0001opus')
})

async function deviceId(hangar: Hangar): Promise<string> {
  return (await hangar.invoke<{ device: { deviceId: string } }>('platform:state')).device.deviceId
}
