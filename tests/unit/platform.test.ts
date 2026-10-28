// Platform connection (src/main/features/platform): PKCE, state comparison, Windows policy parsing, the OAuth
// loopback login and rotating refresh, against the fake platform in tests/mock-platform.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiClient, TokenManager } from '../../src/main/features/platform/client'
import { PlatformError } from '../../src/main/features/platform/errors'
import { login, refreshTokens, startLoopback, type TokenSet } from '../../src/main/features/platform/oauth'
import { challengeS256, createState, createVerifier, sameState } from '../../src/main/features/platform/pkce'
import { normalizeUrl, parseRegQuery, POLICY_KEYS, readPolicy } from '../../src/main/features/platform/policy'
import { MOCK_USER, startMockPlatform, type MockPlatform } from '../mock-platform/server'

const fetchFn = (url: string, init?: RequestInit) => fetch(url, init)

/** Plays the browser: follows the authorize redirect to the app's loopback callback. */
const browser = async (url: string) => {
  const res = await fetch(url)
  await res.text()
}

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('generates 43-char base64url verifiers, never twice the same', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const v = createVerifier()
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(challengeS256(v)).toMatch(/^[A-Za-z0-9_-]{43}$/)
      seen.add(v)
    }
    expect(seen.size).toBe(50)
  })
})

describe('state comparison', () => {
  it('accepts only the exact value', () => {
    const s = createState()
    expect(sameState(s, s)).toBe(true)
    expect(sameState(s, `${s}x`)).toBe(false)
    expect(sameState(s, s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'))).toBe(false)
    expect(sameState(s, s.toUpperCase() === s ? s.toLowerCase() : s.toUpperCase())).toBe(false)
  })

  it('rejects missing values on either side', () => {
    expect(sameState('abc', null)).toBe(false)
    expect(sameState('abc', undefined)).toBe(false)
    expect(sameState('abc', '')).toBe(false)
    expect(sameState('', '')).toBe(false)
  })
})

describe('Windows policy', () => {
  const machineOut = [
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Policies\\Hangar',
    '    PlatformUrl    REG_SZ    https://hangar.acme.example/',
    '    Mode    REG_SZ    Required',
    '    Other    REG_DWORD    0x1',
    ''
  ].join('\r\n')
  const userOut = [
    '',
    'HKEY_CURRENT_USER\\Software\\Policies\\Hangar',
    '    platformurl    REG_SZ    https://user.example',
    '    MODE    REG_SZ    optional',
    ''
  ].join('\r\n')

  it('parses reg query output (names case-insensitive, URL normalized, mode lowercased)', () => {
    expect(parseRegQuery(machineOut)).toEqual({ url: 'https://hangar.acme.example', mode: 'required' })
    expect(parseRegQuery(userOut)).toEqual({ url: 'https://user.example', mode: 'optional' })
  })

  it('ignores invalid values and empty output', () => {
    expect(parseRegQuery('')).toEqual({})
    expect(
      parseRegQuery('    PlatformUrl    REG_SZ    ftp://nope\r\n    Mode    REG_SZ    sometimes\r\n    Mode2    REG_SZ')
    ).toEqual({})
    expect(parseRegQuery('    PlatformUrl    REG_SZ    \r\n')).toEqual({})
    expect(parseRegQuery('    PlatformUrl    REG_EXPAND_SZ    https://x.example/base//')).toEqual({
      url: 'https://x.example/base'
    })
  })

  it('HKLM wins over HKCU value by value', async () => {
    const query = (outputs: Record<string, string>) => async (key: string) => outputs[key] ?? ''
    expect(await readPolicy(query({ [POLICY_KEYS.machine]: machineOut, [POLICY_KEYS.user]: userOut }))).toEqual({
      url: { value: 'https://hangar.acme.example', scope: 'machine' },
      mode: { value: 'required', scope: 'machine' }
    })
    const machineUrlOnly = '    PlatformUrl    REG_SZ    https://m.example\r\n'
    expect(await readPolicy(query({ [POLICY_KEYS.machine]: machineUrlOnly, [POLICY_KEYS.user]: userOut }))).toEqual({
      url: { value: 'https://m.example', scope: 'machine' },
      mode: { value: 'optional', scope: 'user' }
    })
    expect(await readPolicy(query({ [POLICY_KEYS.user]: userOut }))).toEqual({
      url: { value: 'https://user.example', scope: 'user' },
      mode: { value: 'optional', scope: 'user' }
    })
    // Missing keys: reg exits 1 and the runner resolves ''.
    expect(await readPolicy(query({}))).toEqual({})
  })

  it('normalizes URLs', () => {
    expect(normalizeUrl(' https://a.example/x/ ')).toBe('https://a.example/x')
    expect(normalizeUrl('https://a.example')).toBe('https://a.example')
    // The MCP endpoint pasted from the portal points at the same platform.
    expect(normalizeUrl('https://a.example/mcp')).toBe('https://a.example')
    expect(normalizeUrl('https://a.example/base/MCP/')).toBe('https://a.example/base')
    expect(normalizeUrl('https://user:pw@a.example')).toBeUndefined()
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeUrl('not a url')).toBeUndefined()
  })
})

describe('loopback callback server', () => {
  it('ignores callbacks with a wrong state and resolves with the right one', async () => {
    const state = createState()
    const lb = await startLoopback(state, { timeoutMs: 10_000 })
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const forged = await fetch(`${lb.redirectUri}?code=evil&state=wrong`)
    expect(forged.status).toBe(400)
    expect((await fetch(lb.redirectUri.replace('/callback', '/other'))).status).toBe(404)
    const ok = await fetch(`${lb.redirectUri}?code=good&state=${state}&iss=x`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Pode fechar esta aba')
    await expect(lb.result).resolves.toEqual({ code: 'good', iss: 'x' })
  })

  it('times out', async () => {
    const lb = await startLoopback(createState(), { timeoutMs: 50 })
    await expect(lb.result).rejects.toMatchObject({ code: 'timeout' })
  })

  it('can be canceled with an AbortSignal', async () => {
    const abort = new AbortController()
    const lb = await startLoopback(createState(), { signal: abort.signal })
    abort.abort()
    await expect(lb.result).rejects.toMatchObject({ code: 'canceled' })
  })

  it('reports access_denied from the platform', async () => {
    const state = createState()
    const lb = await startLoopback(state)
    await fetch(`${lb.redirectUri}?error=access_denied&state=${state}`)
    await expect(lb.result).rejects.toMatchObject({ code: 'denied' })
  })
})

describe('login and rotating refresh against the fake platform', () => {
  let mock: MockPlatform
  let saved: string | undefined

  beforeAll(async () => {
    mock = await startMockPlatform({ tokenDelayMs: 30 })
  })
  afterAll(() => mock.close())

  const doLogin = () =>
    login(mock.url, {
      fetch: fetchFn,
      openBrowser: browser,
      cachedClientId: saved,
      saveClientId: (id) => (saved = id),
      appVersion: '9.9.9-test'
    })

  it('discovers, registers once, and exchanges the code (PKCE, any loopback port)', async () => {
    const t = await doLogin()
    expect(t.accessToken).toMatch(/^aho_/)
    expect(t.refreshToken).toMatch(/^ahr_/)
    expect(t.scope).toBe('app mcp')
    expect(t.expiresAt).toBeGreaterThan(Date.now())
    expect(mock.clients.size).toBe(1)
    const client = [...mock.clients.values()][0]
    expect(client).toMatchObject({
      redirectUris: ['http://127.0.0.1/callback'],
      scope: 'app mcp',
      softwareId: 'hangar-desktop',
      softwareVersion: '9.9.9-test'
    })
    expect(saved).toBe(client.id)
    await doLogin()
    expect(mock.clients.size).toBe(1) // cached client_id reused
  })

  it('surfaces a denied consent', async () => {
    mock.setConsent('deny')
    try {
      await expect(doLogin()).rejects.toMatchObject({ code: 'denied' })
    } finally {
      mock.setConsent('approve')
    }
  })

  it('rotates the refresh token and the platform rejects the spent one (revoking the grant)', async () => {
    const t = await doLogin()
    const next = await refreshTokens(t, fetchFn)
    expect(next.refreshToken).not.toBe(t.refreshToken)
    expect(next.accessToken).not.toBe(t.accessToken)
    // Reusing the old refresh token is treated as a leak: refused, and the whole grant is gone.
    await expect(refreshTokens(t, fetchFn)).rejects.toMatchObject({ code: 'session_expired' })
    await expect(refreshTokens(next, fetchFn)).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('serializes concurrent refreshes: one token request, everyone gets the new tokens', async () => {
    const saves: TokenSet[] = []
    const manager = new TokenManager(fetchFn, { save: async (x) => void saves.push(x) })
    const t = await doLogin()
    manager.set(t)
    const before = mock.count('/oauth/token', 'refresh_token')
    const results = await Promise.all(Array.from({ length: 5 }, () => manager.refresh(t.accessToken)))
    expect(mock.count('/oauth/token', 'refresh_token') - before).toBe(1)
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1)
    expect(manager.current?.accessToken).toBe(results[0].accessToken)
    expect(saves).toHaveLength(1)
    // A late caller with the stale token gets the current tokens without spending the refresh token again.
    await expect(manager.refresh(t.accessToken)).resolves.toBe(manager.current)
    expect(mock.count('/oauth/token', 'refresh_token') - before).toBe(1)
    // The grant is still alive: no reuse was detected.
    expect(mock.grants.at(-1)?.revoked).toBe(false)
  })

  it('ApiClient refreshes once on 401 and retries (also with concurrent requests)', async () => {
    const manager = new TokenManager(fetchFn, { save: async () => {} })
    manager.set(await doLogin())
    const api = new ApiClient(fetchFn, manager)
    const me = await api.request<{ user: { email: string } }>('GET', '/api/app/me')
    expect(me.user.email).toBe(MOCK_USER.email)

    mock.expireAccessTokens()
    // The local expiry still says "valid", so the 401 path is what refreshes.
    const before = mock.count('/oauth/token', 'refresh_token')
    const all = await Promise.all([
      api.request<{ user: { email: string } }>('GET', '/api/app/me'),
      api.request<{ user: { email: string } }>('GET', '/api/app/me'),
      api.request<{ user: { email: string } }>('GET', '/api/app/me')
    ])
    expect(all.every((r) => r.user.email === MOCK_USER.email)).toBe(true)
    expect(mock.count('/oauth/token', 'refresh_token') - before).toBe(1)
    expect(mock.grants.at(-1)?.revoked).toBe(false)
  })

  it('refreshes ahead of expiry', async () => {
    let now = Date.now()
    const manager = new TokenManager(fetchFn, { save: async () => {} }, () => now)
    const t = await doLogin()
    manager.set(t)
    expect(await manager.accessToken()).toBe(t.accessToken)
    now = t.expiresAt - 30_000 // inside the one-minute margin
    const before = mock.count('/oauth/token', 'refresh_token')
    expect(await manager.accessToken()).not.toBe(t.accessToken)
    expect(mock.count('/oauth/token', 'refresh_token') - before).toBe(1)
  })

  it('a revoked grant ends in session_expired and readable errors', async () => {
    const manager = new TokenManager(fetchFn, { save: async () => {} })
    manager.set(await doLogin())
    const api = new ApiClient(fetchFn, manager)
    mock.grants.at(-1)!.revoked = true
    const err = await api.request('GET', '/api/app/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlatformError)
    expect(err).toMatchObject({ code: 'session_expired' })
    expect((err as Error).message).toMatch(/Conecte de novo/)
  })

  it('reports an unreachable platform in Portuguese', async () => {
    const err = await login('http://127.0.0.1:1', {
      fetch: fetchFn,
      openBrowser: browser,
      saveClientId: () => {},
      appVersion: 'x'
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'network' })
    expect((err as Error).message).toMatch(/Não foi possível conectar a 127\.0\.0\.1:1/)
  })
})
