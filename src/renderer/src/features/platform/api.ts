// Typed wrappers for the platform feature's IPC, plus a store that mirrors PlatformState from main.
import { create } from 'zustand'
import { PLATFORM, type PlatformConfigPatch, type PlatformState } from '@shared/features/platform'
import { bridge } from '../../core/api'

export const platformApi = {
  state: () => bridge.invoke(PLATFORM.state),
  setConfig: (patch: PlatformConfigPatch) => bridge.invoke(PLATFORM.setConfig, patch),
  connect: () => bridge.invoke(PLATFORM.connect),
  cancelConnect: () => bridge.invoke(PLATFORM.cancelConnect),
  disconnect: () => bridge.invoke(PLATFORM.disconnect),
  refresh: () => bridge.invoke(PLATFORM.refresh)
}

export const usePlatformStore = create<{ state?: PlatformState }>(() => ({}))

// One subscription for the whole renderer, started the first time this module loads.
bridge.on(PLATFORM.evState, (state) => usePlatformStore.setState({ state }))
void platformApi
  .state()
  .then((state) => usePlatformStore.setState((s) => (s.state ? s : { state })))
  .catch((err) => console.warn('[platform] state failed', err))

/** Current PlatformState (undefined until main answers). */
export function usePlatform(): PlatformState | undefined {
  return usePlatformStore((s) => s.state)
}

/** Non-hook read: mode `required` and not connected (for event handlers). */
export function isPlatformBlocking(): boolean {
  return usePlatformStore.getState().state?.canCreateSessions === false
}

/** Whether new sessions may be created (true while the state is still loading). */
export function useCanCreateSessions(): boolean {
  return usePlatformStore((s) => s.state?.canCreateSessions ?? true)
}

/** Runs an action that resolves to a new state; returns the error text instead of throwing. */
export async function runAction(action: () => Promise<PlatformState | void>): Promise<string | undefined> {
  try {
    const next = await action()
    if (next) usePlatformStore.setState({ state: next })
    return undefined
  } catch (err) {
    return errorText(err)
  }
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

export const MODE_LABEL = {
  off: 'Desligado',
  optional: 'Opcional',
  required: 'Obrigatório'
} as const

export function statusLabel(state: PlatformState): string {
  switch (state.status) {
    case 'off':
      return 'Desligado'
    case 'unconfigured':
      return 'Sem URL'
    case 'disconnected':
      return 'Desconectado'
    case 'connecting':
      return 'Conectando…'
    case 'connected':
      return 'Conectado'
    case 'error':
      return 'Sem resposta da plataforma'
  }
}

export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}
