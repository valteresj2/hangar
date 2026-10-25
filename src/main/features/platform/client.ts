// Tokens in use and the HTTP client of the app API (/api/app, Bearer with scope `app`).
// TokenManager serializes refreshes: the platform rotates refresh tokens and treats a reused one as a leak (it
// revokes the whole grant), so two concurrent 401s must never both spend the same refresh token.
import { PlatformError, httpError, networkError, notConnected } from './errors'
import { refreshTokens, type FetchFn, type TokenSet } from './oauth'

/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000
const HTTP_TIMEOUT_MS = 20_000

export interface TokenPersistence {
  save(tokens: TokenSet): Promise<void>
}

export class TokenManager {
  private tokens: TokenSet | undefined
  private inflight: Promise<TokenSet> | undefined

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly persistence: TokenPersistence,
    private readonly now: () => number = Date.now
  ) {}

  get current(): TokenSet | undefined {
    return this.tokens
  }

  set(tokens: TokenSet | undefined): void {
    this.tokens = tokens
  }

  /** An access token that is not about to expire (refreshing first when needed). */
  async accessToken(): Promise<string> {
    const t = this.inflight ? await this.inflight : this.tokens
    if (!t) throw notConnected()
    if (t.expiresAt && t.expiresAt - EXPIRY_MARGIN_MS <= this.now() && t.refreshToken)
      return (await this.refresh(t.accessToken)).accessToken
    return t.accessToken
  }

  /**
   * Rotates the tokens. `stale` is the access token that just got a 401: if another caller already replaced it,
   * the newer tokens are returned without spending the refresh token again. Concurrent callers share one request.
   */
  refresh(stale?: string): Promise<TokenSet> {
    if (this.inflight) return this.inflight
    const current = this.tokens
    if (!current) return Promise.reject(notConnected())
    if (stale && current.accessToken !== stale) return Promise.resolve(current)
    const run = (async () => {
      const next = await refreshTokens(current, this.fetchFn)
      // A logout (or a new login) while the request was in flight wins.
      if (this.tokens !== current) throw notConnected()
      this.tokens = next
      await this.persistence.save(next)
      return next
    })()
    this.inflight = run
    void run.then(
      () => (this.inflight = this.inflight === run ? undefined : this.inflight),
      () => (this.inflight = this.inflight === run ? undefined : this.inflight)
    )
    return run
  }
}

export class ApiClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly tokens: TokenManager
  ) {}

  private base(): string {
    const t = this.tokens.current
    if (!t) throw notConnected()
    return t.url
  }

  private async send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    const url = `${this.base()}${path}`
    try {
      return await this.fetchFn(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      })
    } catch (err) {
      throw networkError(url, err)
    }
  }

  /** JSON request to the app API; a 401 triggers one refresh and one retry. */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let token = await this.tokens.accessToken()
    let res = await this.send(method, path, token, body)
    if (res.status === 401) {
      token = (await this.tokens.refresh(token)).accessToken
      res = await this.send(method, path, token, body)
    }
    let data: unknown
    try {
      data = await res.json()
    } catch {
      data = undefined
    }
    if (!res.ok) {
      const detail =
        data && typeof data === 'object' && typeof (data as { detail?: unknown }).detail === 'string'
          ? (data as { detail: string }).detail
          : undefined
      throw httpError(res.status, detail, path)
    }
    if (data === undefined) throw new PlatformError('http', `A plataforma devolveu uma resposta inválida em ${path}.`)
    return data as T
  }
}
