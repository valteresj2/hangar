// Opt-in: the platform connection against a REAL Agent Hangar development instance (never a production one: the
// test revokes the device it registers). Skipped unless these are set:
//   HANGAR_PLATFORM_URL       e.g. http://localhost:8091
//   HANGAR_PLATFORM_USER      local-login user of that instance (an admin, to revoke the device at the end)
//   HANGAR_PLATFORM_PASSWORD
// The person's part of the login (local login + consent screen) is done over HTTP, like the portal does it.
// Synced token models (docs/platform/app-api-models.md) also need, on that instance, a synced LLM connection whose
// upstream is a fake Anthropic (tests/mock-anthropic/cli.ts); HANGAR_PLATFORM_CONNECTION names it (default
// "mock-anthropic"). The test turns its sync off and on again through the admin API.
import { TEXT_REPLY } from '../mock-anthropic/scripts.ts'
import { expect, test, type Hangar } from './fixtures.ts'

const URL_ = process.env.HANGAR_PLATFORM_URL ?? ''
const USER = process.env.HANGAR_PLATFORM_USER ?? ''
const PASSWORD = process.env.HANGAR_PLATFORM_PASSWORD ?? ''
const CONNECTION = process.env.HANGAR_PLATFORM_CONNECTION ?? 'mock-anthropic'

interface State {
  status: string
  canCreateSessions: boolean
  error?: string
  user?: { email: string; name: string }
  org?: { name: string }
  device: { deviceId: string; status: string }
  notice?: { message: string }
  models: {
    status: string
    error?: string
    connections: { id: number; name: string; profileId: string; models: { id: string }[] }[]
  }
}

/** A cookie session on the platform (local login), with the CSRF double-submit header. */
async function portalSession(): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const res = await fetch(`${URL_}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD })
  })
  expect(res.ok, `local login failed: HTTP ${res.status} ${await res.clone().text()}`).toBe(true)
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
  const csrf = cookies.find((c) => c.startsWith('hangar_csrf='))?.split('=')[1] ?? ''
  return (path, init = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers ?? {}), cookie: cookies.join('; '), 'x-csrf-token': csrf }
    })
}

async function captureBrowser(hangar: Hangar): Promise<() => Promise<string>> {
  await hangar.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      ;(globalThis as { __authUrl?: string }).__authUrl = url
    }
  })
  return async () => {
    let url: string | undefined
    await expect
      .poll(async () => (url = await hangar.app.evaluate(() => (globalThis as { __authUrl?: string }).__authUrl)))
      .toBeTruthy()
    return url!
  }
}

test.skip(!URL_ || !USER || !PASSWORD, 'HANGAR_PLATFORM_URL/USER/PASSWORD not set')

/** Logs the app in from the UI; the "browser" is this test (authorize → local login → consent → callback). */
async function loginFromApp(hangar: Hangar, portal: Awaited<ReturnType<typeof portalSession>>): Promise<State> {
  const authUrl = await captureBrowser(hangar)
  await hangar.page.getByRole('button', { name: 'Conectar à plataforma' }).first().click()
  const authorize = await fetch(await authUrl(), { redirect: 'manual' })
  const consentPage = new URL(authorize.headers.get('location') ?? '', URL_)
  const params = Object.fromEntries(new URLSearchParams(consentPage.hash.split('?')[1] ?? ''))
  const consent = await portal('/api/oauth/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params, approve: true })
  })
  expect(consent.ok, await consent.clone().text()).toBe(true)
  await (await fetch(((await consent.json()) as { redirect: string }).redirect)).text()
  await expect
    .poll(async () => (await hangar.invoke<State>('platform:state')).status, { timeout: 30_000 })
    .toBe('connected')
  return hangar.invoke<State>('platform:state')
}

test('real platform: login, me, device, heartbeat, revoked by the admin', async ({ hangar }) => {
  const { page, invoke } = hangar
  const authUrl = await captureBrowser(hangar)
  await invoke('platform:setConfig', { url: URL_, mode: 'required' })

  // Start the login from the UI; the "browser" is this test.
  await page.getByRole('alert').getByRole('button', { name: 'Conectar à plataforma' }).click()
  const authorize = await fetch(await authUrl(), { redirect: 'manual' })
  expect(authorize.status).toBe(302)
  const consentPage = new URL(authorize.headers.get('location') ?? '', URL_)
  const params = Object.fromEntries(new URLSearchParams(consentPage.hash.split('?')[1] ?? ''))
  expect(params).toMatchObject({ scope: 'app mcp', code_challenge_method: 'S256' })
  expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  const portal = await portalSession()
  const consent = await portal('/api/oauth/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params, approve: true })
  })
  expect(consent.ok, await consent.clone().text()).toBe(true)
  const { redirect } = (await consent.json()) as { redirect: string }
  const callback = await fetch(redirect)
  expect(await callback.text()).toContain('Pode fechar esta aba')

  await expect.poll(async () => (await invoke<State>('platform:state')).status, { timeout: 30_000 }).toBe('connected')
  const state = await invoke<State>('platform:state')
  console.log(`[real] connected as ${state.user?.email} (${state.org?.name}), device ${state.device.deviceId}`)
  expect(state.canCreateSessions).toBe(true)
  expect(state.device.status).toBe('active')
  await expect(page.getByText(state.org?.name ?? state.user?.name ?? '').first()).toBeVisible()

  // The admin sees the device.
  const devices = (await (await portal('/api/app/admin/devices')).json()) as {
    id: number
    device_id: string
    status: string
  }[]
  const mine = devices.find((d) => d.device_id === state.device.deviceId)
  expect(mine?.status).toBe('active')

  // Heartbeat.
  const again = await invoke<State>('platform:refresh')
  expect(again.status).toBe('connected')

  // Admin revokes it: the next heartbeat logs the app out.
  const revoke = await portal(`/api/app/admin/devices/${mine!.id}/revoke`, { method: 'POST' })
  expect(revoke.ok, await revoke.clone().text()).toBe(true)
  const revoked = await invoke<State>('platform:refresh')
  console.log(`[real] after revoke: ${revoked.status} — ${revoked.notice?.message}`)
  expect(revoked.status).toBe('disconnected')
  expect(revoked.canCreateSessions).toBe(false)
  expect(revoked.notice?.message).toMatch(/revogado/)
})

test('real platform: synced token models, a turn through the LLM proxy, sync off falls back', async ({ hangar }) => {
  const { page, invoke } = hangar
  const portal = await portalSession()
  const setSync = async (sync: boolean) => {
    const res = await portal(`/api/catalog/llm/${encodeURIComponent(CONNECTION)}/desktop`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sync })
    })
    expect(res.ok, await res.clone().text()).toBe(true)
  }
  await setSync(true)
  await invoke('platform:setConfig', { url: URL_, mode: 'optional' })
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Plataforma', exact: true }).click()

  try {
    await loginFromApp(hangar, portal)
    // Connecting starts a models sync (and the events stream may start another): wait for it to settle.
    await expect
      .poll(async () => (await invoke<State>('platform:state')).models.status, { timeout: 30_000 })
      .not.toBe('syncing')
    const state = await invoke<State>('platform:state')
    const conn = state.models.connections.find((c) => c.name === CONNECTION)
    console.log(
      `[real] models: ${state.models.status}, ${state.models.connections.map((c) => `${c.name}(${c.models.map((m) => m.id).join(',')})`).join(' ')}`
    )
    expect(conn, `connection ${CONNECTION} not synced: ${JSON.stringify(state.models)}`).toBeTruthy()
    await page.keyboard.press('Escape')

    // Pick a token model in the composer and run a turn: app → proxy (device key) → fake upstream.
    const session = await hangar.openNewSession({ title: 'E2E Real Modelos de token' })
    const picker = page.getByLabel('Modelo', { exact: true })
    const option = picker.locator(`optgroup[label="Modelos de token · ${CONNECTION}"] option`).first()
    const label = (await option.textContent()) ?? ''
    await picker.selectOption({ label })
    await expect
      .poll(async () => (await invoke<{ providerId?: string }>('store:get', 'sessions', session.id)).providerId)
      .toBe(conn!.profileId)
    const composer = page.getByPlaceholder(/Responder ao Claude/)
    await composer.fill('[[script:text delay=80 repeat=3]] Olá pela plataforma')
    await composer.press('Enter')
    await expect(page.getByText(`Parte 3. ${TEXT_REPLY}`)).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText(new RegExp(`Token · ${CONNECTION}`))).toBeVisible()
    console.log(`[real] answered through the proxy with "${label}"`)

    // The admin stops syncing it: the profile goes and the session falls back to the subscription.
    await setSync(false)
    const off = await invoke<State>('platform:syncModels')
    expect(off.models.connections.some((c) => c.name === CONNECTION)).toBe(false)
    expect((await invoke<{ providerId?: string }>('store:get', 'sessions', session.id)).providerId).toBe('subscription')
    await expect(page.getByText(/não estão mais disponíveis/)).toBeVisible()
  } finally {
    // Leave the instance as it was.
    await setSync(true)
    await invoke('platform:disconnect').catch(() => undefined)
  }
})
