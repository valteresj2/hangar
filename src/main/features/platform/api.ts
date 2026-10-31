// Main-side API of the platform feature for other features (sessions uses it to refuse new sessions; workspace
// reads the member's routes and the event stream through the same login).
import { PLATFORM_REQUIRED_MESSAGE, type PlatformState } from '../../../shared/features/platform'
import { apiClient, currentLogin, effectiveConfig, getState, onStateChange, refresh, syncModelsNow } from './controller'
import { PlatformError } from './errors'

export { PLATFORM_MCP_NAME, platformMcpServer } from './mcpBridge'

/** False when the platform is required (mode `required`) and the app is not connected. */
export function canCreateSessions(): boolean {
  return getState().canCreateSessions
}

/** Throws the pt-BR "connect to the platform" message when sessions cannot be created. */
export function assertCanCreateSessions(): void {
  if (!canCreateSessions()) throw new Error(PLATFORM_REQUIRED_MESSAGE)
}

export { PlatformError }
export type { PlatformState }

/** Current platform state (the same the renderer gets). */
export const platformState = (): PlatformState => getState()

/** Called after every change of the platform state; returns the unsubscribe function. */
export const onPlatformState = (listener: (state: PlatformState) => void): (() => void) => onStateChange(listener)

/** URL and user of the current login (undefined when logged out). */
export const platformLogin = (): { url: string; userId: string; name: string } | undefined => currentLogin()

/** The configured platform URL ('' when none), logged in or not: where the portal is. */
export const platformUrl = (): string => (effectiveConfig().mode === 'off' ? '' : effectiveConfig().url)

/** GET on a route the app token may use (member routes of docs/platform/m1-contract.md, /api/app/*). */
export function platformGet<T>(path: string): Promise<T> {
  if (!currentLogin()) return Promise.reject(new PlatformError('not_connected', 'O Hangar não está conectado.'))
  return apiClient.request<T>('GET', path)
}

/** Opens an event stream (SSE) of the platform with the app's token. */
export function platformStream(path: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  if (!currentLogin()) return Promise.reject(new PlatformError('not_connected', 'O Hangar não está conectado.'))
  return apiClient.stream(path, headers, signal)
}

/** Checks the login again (heartbeat + /me): a refused token ends it the usual way (notice, logout). */
export const recheckPlatform = (): Promise<unknown> => refresh().catch(() => undefined)

/** Fetches the synced token models now (the platform announced a new list). */
export const syncPlatformModels = (): Promise<unknown> => syncModelsNow().catch(() => undefined)
