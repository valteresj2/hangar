// Errors of the platform connection, with messages ready for the UI (pt-BR).

export type PlatformErrorCode =
  | 'config' // missing/invalid URL, mode off
  | 'network' // could not reach the platform
  | 'discovery' // no OAuth metadata at that URL
  | 'registration' // dynamic client registration refused
  | 'canceled'
  | 'timeout'
  | 'denied' // the person refused the consent screen
  | 'oauth' // other OAuth error on the callback or the token endpoint
  | 'invalid_client' // registered client unknown/blocked: register again
  | 'session_expired' // refresh refused (revoked, expired, reused)
  | 'not_connected'
  | 'forbidden' // 403: device revoked or user without access
  | 'revoked' // heartbeat answered `revoked`
  | 'not_found'
  | 'http' // other HTTP error
  | 'storage' // safeStorage unavailable

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const networkError = (url: string, cause?: unknown): PlatformError => {
  const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  return new PlatformError(
    'network',
    timedOut
      ? `A plataforma em ${hostOf(url)} não respondeu a tempo. Confira a URL e a sua rede.`
      : `Não foi possível conectar a ${hostOf(url)}. Confira a URL e a sua rede.`
  )
}

export const sessionExpired = (): PlatformError =>
  new PlatformError('session_expired', 'Sua sessão na plataforma expirou ou foi revogada. Conecte de novo.')

export const notConnected = (): PlatformError =>
  new PlatformError('not_connected', 'O Hangar não está conectado à plataforma.')

/** Error for an HTTP response of the app API (`{"detail": "..."}` bodies). */
export function httpError(status: number, detail: string | undefined, path: string): PlatformError {
  const suffix = detail ? ` (${detail})` : ''
  if (status === 401) return sessionExpired()
  if (status === 403)
    return new PlatformError(
      'forbidden',
      detail
        ? `A plataforma recusou o acesso: ${detail}`
        : 'A plataforma recusou o acesso (dispositivo revogado ou usuário sem acesso).',
      status
    )
  if (status === 404)
    return new PlatformError(
      'not_found',
      `A plataforma não reconheceu ${path}. Ela pode estar desatualizada para este app.${suffix}`,
      status
    )
  if (status >= 500)
    return new PlatformError('http', `A plataforma respondeu com erro ${status}. Tente mais tarde.${suffix}`, status)
  return new PlatformError('http', `A plataforma recusou o pedido (HTTP ${status}).${suffix}`, status)
}

/** Message of any error, for the UI. */
export function errorMessage(err: unknown): string {
  if (err instanceof PlatformError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
