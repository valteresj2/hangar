// Typed wrappers for the workspace feature's IPC, a store mirroring WorkspaceState from main, and deep-link
// navigation (a `hangar://open/…` link that names a native screen opens it in the center).
import { create } from 'zustand'
import {
  WORKSPACE,
  type PortalTarget,
  type WorkspaceNavigation,
  type WorkspaceScope,
  type WorkspaceState
} from '@shared/features/workspace'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'

export const workspaceApi = {
  state: () => bridge.invoke(WORKSPACE.state),
  refresh: (scope?: WorkspaceScope) => bridge.invoke(WORKSPACE.refresh, scope),
  openPortal: (target: PortalTarget, label?: string) => bridge.invoke(WORKSPACE.openPortal, target, label),
  takeNavigation: () => bridge.invoke(WORKSPACE.takeNavigation)
}

export const useWorkspaceStore = create<{ state?: WorkspaceState }>(() => ({}))

function navigate(nav: WorkspaceNavigation): void {
  if ('view' in nav) useUi.getState().openWorkspace(nav.view)
  else void workspaceApi.openPortal(nav.portal)
}

// One subscription for the whole renderer, started the first time this module loads.
bridge.on(WORKSPACE.evState, (state) => useWorkspaceStore.setState({ state }))
bridge.on(WORKSPACE.evNavigate, navigate)
void workspaceApi
  .state()
  .then((state) => useWorkspaceStore.setState((s) => (s.state ? s : { state })))
  .catch((err) => console.warn('[workspace] state failed', err))
// A deep link that launched the app (or arrived while this window was loading).
void workspaceApi
  .takeNavigation()
  .then((nav) => nav && navigate(nav))
  .catch(() => undefined)

export function useWorkspace(): WorkspaceState | undefined {
  return useWorkspaceStore((s) => s.state)
}

/** Opens a portal screen; agents, employees and tasks opened with a label go to "Vistos recentemente". */
export function openPortal(target: PortalTarget, label?: string): void {
  void workspaceApi.openPortal(target, label).catch((err) => console.warn('[workspace] portal failed', err))
}
