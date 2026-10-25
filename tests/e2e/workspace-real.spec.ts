// Opt-in: the member's workspace against a REAL Agent Hangar development instance (never a production one).
// Skipped unless these are set:
//   HANGAR_PLATFORM_URL               e.g. http://localhost:8091
//   HANGAR_PLATFORM_MEMBER_USER       local-login user of a member with agents (e.g. dev-membro)
//   HANGAR_PLATFORM_MEMBER_PASSWORD
// The person's part of the login (local login + consent screen) is done over HTTP, like the portal does it. The live
// event is reversible: the member marks an inbox item read in the portal (inbox.changed) and unread again.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, REPO_ROOT, test, type Hangar } from './fixtures.ts'

const URL_ = process.env.HANGAR_PLATFORM_URL ?? ''
const USER = process.env.HANGAR_PLATFORM_MEMBER_USER ?? ''
const PASSWORD = process.env.HANGAR_PLATFORM_MEMBER_PASSWORD ?? ''

test.skip(!URL_ || !USER || !PASSWORD, 'HANGAR_PLATFORM_URL/MEMBER_USER/MEMBER_PASSWORD not set')

type Portal = (path: string, init?: RequestInit) => Promise<Response>

/** A cookie session of the member on the platform (local login), with the CSRF double-submit header. */
async function portalSession(): Promise<Portal> {
  const res = await fetch(`${URL_}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD })
  })
  expect(res.ok, `local login failed: HTTP ${res.status}`).toBe(true)
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
  const csrf = cookies.find((c) => c.startsWith('hangar_csrf='))?.split('=')[1] ?? ''
  return (path, init = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.headers ?? {}),
        cookie: cookies.join('; '),
        'x-csrf-token': csrf,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      }
    })
}

const getJson = async <T>(portal: Portal, path: string): Promise<T> => {
  const res = await portal(path)
  expect(res.ok, `${path}: HTTP ${res.status}`).toBe(true)
  return (await res.json()) as T
}

/** Logs the app in; the "browser" is this test (authorize → consent with the member's cookie → callback). */
async function login(hangar: Hangar, portal: Portal): Promise<void> {
  await hangar.app.evaluate(({ shell }) => {
    const g = globalThis as { __authUrl?: string; __opened?: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      if (!g.__authUrl && url.includes('/oauth/authorize')) g.__authUrl = url
      else g.__opened!.push(url)
    }
  })
  await hangar.invoke('platform:setConfig', { url: URL_, mode: 'optional' })
  const connecting = hangar.invoke<{ status: string }>('platform:connect')
  let authUrl: string | undefined
  await expect
    .poll(async () => (authUrl = await hangar.app.evaluate(() => (globalThis as { __authUrl?: string }).__authUrl)))
    .toBeTruthy()
  const authorize = await fetch(authUrl!, { redirect: 'manual' })
  const consentPage = new URL(authorize.headers.get('location') ?? '', URL_)
  const params = Object.fromEntries(new URLSearchParams(consentPage.hash.split('?')[1] ?? ''))
  const consent = await portal('/api/oauth/consent', {
    method: 'POST',
    body: JSON.stringify({ params, approve: true })
  })
  expect(consent.ok, await consent.clone().text()).toBe(true)
  await (await fetch(((await consent.json()) as { redirect: string }).redirect)).text()
  expect((await connecting).status).toBe('connected')
}

async function launchWithLink(hangar: Hangar, link: string): Promise<void> {
  const exe = createRequire(import.meta.url)('electron') as unknown as string
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  const child = spawn(exe, [REPO_ROOT, `--user-data-dir=${hangar.userData}`, link], {
    cwd: REPO_ROOT,
    env: { ...env, HANGAR_E2E: '1' },
    stdio: 'ignore'
  })
  await new Promise((resolve) => child.on('exit', resolve))
}

interface Workspace {
  to_decide: number
  workspace: string
  agents: { slug: string; name: string }[]
  built_agents: { slug: string }[]
}

test('real platform: Início and Meus agentes with the member data, live inbox badge, deep link', async ({ hangar }) => {
  const { page, invoke } = hangar
  const portal = await portalSession()
  await login(hangar, portal)

  // What the portal shows the same person.
  const ws = await getJson<Workspace>(portal, '/api/me/workspace')
  const decisions = await getJson<{ kind: string }[]>(portal, '/api/decisions')
  const inbox = await getJson<{ counts: { unread: number }; items: { key: string; unread: boolean }[] }>(
    portal,
    '/api/inbox'
  )
  const toDecide = decisions.filter((d) => d.kind !== 'notice').length
  console.log(
    `[real] ${ws.workspace}: ${ws.agents.length} employees, ${ws.built_agents.length} agents, ${toDecide} to decide, ${inbox.counts.unread} unread`
  )

  const nav = page.getByRole('region', { name: 'Agent Hangar' })
  await expect(nav.getByLabel(/Ao vivo/)).toBeVisible({ timeout: 30_000 })
  const inboxBadge = nav.locator('[data-badge="Caixa de entrada"]')
  if (inbox.counts.unread) await expect(inboxBadge).toHaveText(String(inbox.counts.unread))
  if (toDecide) await expect(nav.locator('[data-badge="Decisões"]')).toHaveText(String(toDecide))

  await nav.getByRole('button', { name: 'Início', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible()
  await expect(page.getByRole('main').getByText(ws.workspace, { exact: true })).toBeVisible()
  await expect(page.locator('[data-kpi="Para você decidir"]')).toContainText(String(toDecide))
  await expect(page.locator('[data-kpi="Meus agentes"]')).toContainText(
    String(ws.agents.length + ws.built_agents.length)
  )

  // Live: the member reads an item in the portal, the badge follows; then it is unread again (state restored).
  const item = inbox.items.find((i) => i.unread)
  if (item) {
    const mark = (read: boolean) =>
      portal('/api/inbox/mark', { method: 'POST', body: JSON.stringify({ keys: [item.key], read }) })
    try {
      expect((await mark(true)).ok).toBe(true)
      if (inbox.counts.unread > 1)
        await expect(inboxBadge).toHaveText(String(inbox.counts.unread - 1), { timeout: 15_000 })
      else await expect(inboxBadge).toHaveCount(0, { timeout: 15_000 })
    } finally {
      await mark(false)
    }
    await expect(inboxBadge).toHaveText(String(inbox.counts.unread), { timeout: 15_000 })
  }

  // Deep link → Meus agentes, with every agent of the person.
  await launchWithLink(hangar, 'hangar://open/workspace/agents')
  await expect(page.getByRole('heading', { level: 1, name: 'Meus agentes' })).toBeVisible()
  for (const a of [...ws.agents, ...ws.built_agents])
    await expect(page.locator(`[data-agent="${a.slug}"]`)).toBeVisible()

  // Details open the portal of that instance.
  const first = ws.agents[0]
  if (first) {
    await page.locator(`[data-agent="${first.slug}"]`).getByRole('button', { name: /Abrir/ }).click()
    await expect
      .poll(() => hangar.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []))
      .toContain(`${URL_}/app#/employees/${first.slug}`)
  }

  await invoke('platform:disconnect')
  await expect(nav.getByRole('button', { name: 'Conecte à plataforma' })).toBeVisible()
})
