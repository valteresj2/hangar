// Opt-in: the platform connection against a REAL Agent Hangar development instance (never a production one: the
// test revokes the device it registers). Skipped unless these are set:
//   HANGAR_PLATFORM_URL       e.g. http://localhost:8091
//   HANGAR_PLATFORM_USER      local-login user of that instance (an admin, to revoke the device at the end)
//   HANGAR_PLATFORM_PASSWORD
// The person's part of the login (local login + consent screen) is done over HTTP, like the portal does it.
import { expect, test, type Hangar } from './fixtures.ts'

const URL_ = process.env.HANGAR_PLATFORM_URL ?? ''
const USER = process.env.HANGAR_PLATFORM_USER ?? ''
const PASSWORD = process.env.HANGAR_PLATFORM_PASSWORD ?? ''

interface State {
  status: string
  canCreateSessions: boolean
  error?: string
  user?: { email: string; name: string }
  org?: { name: string }
  device: { deviceId: string; status: string }
  notice?: { message: string }
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
