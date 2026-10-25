// Main-side API of the platform feature for other features (sessions uses it to refuse new sessions).
import { PLATFORM_REQUIRED_MESSAGE } from '../../../shared/features/platform'
import { getState } from './controller'

/** False when the platform is required (mode `required`) and the app is not connected. */
export function canCreateSessions(): boolean {
  return getState().canCreateSessions
}

/** Throws the pt-BR "connect to the platform" message when sessions cannot be created. */
export function assertCanCreateSessions(): void {
  if (!canCreateSessions()) throw new Error(PLATFORM_REQUIRED_MESSAGE)
}
