// Typed wrappers for the workspace feature's IPC, a store mirroring WorkspaceState from main, and deep-link
// navigation (a `hangar://open/…` link that names a native screen opens it in the center).
import { create } from 'zustand'
import {
  WORKSPACE,
  type AgentAction,
  type DecideInput,
  type FollowChange,
  type FollowedTask,
  type InboxMark,
  type InboxView,
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
  takeNavigation: () => bridge.invoke(WORKSPACE.takeNavigation),
  inbox: (view: InboxView) => bridge.invoke(WORKSPACE.inbox, view),
  markInbox: (keys: string[], change: InboxMark) => bridge.invoke(WORKSPACE.markInbox, keys, change),
  decide: (input: DecideInput) => bridge.invoke(WORKSPACE.decide, input),
  agent: (slug: string) => bridge.invoke(WORKSPACE.agent, slug),
  agentAction: (slug: string, action: AgentAction) => bridge.invoke(WORKSPACE.agentAction, slug, action),
  openInVscode: (slug: string) => bridge.invoke(WORKSPACE.openInVscode, slug),
  followedTasks: (sessionId: string) => bridge.invoke(WORKSPACE.followedTasks, sessionId),
  setFollow: (taskId: number, change: FollowChange) => bridge.invoke(WORKSPACE.setFollow, taskId, change),
  openTaskFile: (fileId: number, reveal?: boolean) => bridge.invoke(WORKSPACE.openTaskFile, fileId, reveal)
}

/** The platform tasks this session follows, live (main pushes each change). */
export const useFollowedTasks = create<{ bySession: Record<string, FollowedTask[]> }>(() => ({ bySession: {} }))

bridge.on(WORKSPACE.evTasks, ({ sessionId, tasks }) =>
  useFollowedTasks.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: tasks } }))
)

export function loadFollowedTasks(sessionId: string): void {
  void workspaceApi
    .followedTasks(sessionId)
    .then((tasks) => useFollowedTasks.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: tasks } })))
    .catch(() => undefined)
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
