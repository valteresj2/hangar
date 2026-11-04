// Feature "workspace" — main process side. Owned by the workspace agent.
// The member's screens of the Agent Hangar platform in the app (docs/platform/m1-contract.md): Início, Meus
// agentes, Decisões and Caixa de entrada from the member routes (deciding, marking the inbox and acting on the person's
// own agents too), live badges from GET /api/app/events, and `hangar://open/<route>` deep links
// (registered by src/main/index.ts through ./api.ts).
import {
  WORKSPACE,
  type AgentAction,
  type DecideInput,
  type FollowChange,
  type InboxMark,
  type InboxView,
  type PortalTarget,
  type WorkspaceScope
} from '../../../shared/features/workspace'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import { notifyAway } from '../settings/tray'
import { followedTasks, onToolResult, openTaskFile, setFollow, startFollowing, stopFollowing } from './follow'
import {
  agentAction,
  agentName,
  agentDetail,
  decide,
  getState,
  inboxItems,
  markInbox,
  openInVscode,
  openPortal,
  refresh,
  start,
  stop,
  takeNavigation
} from './controller'

const SCOPES = new Set<WorkspaceScope>(['all', 'home', 'agents', 'badges'])

export const workspaceFeature: Feature = {
  name: 'workspace',
  register(ctx) {
    handle(WORKSPACE.state, () => getState())
    handle(WORKSPACE.refresh, (_e, scope?: WorkspaceScope) => refresh(scope && SCOPES.has(scope) ? scope : 'all'))
    handle(WORKSPACE.openPortal, (_e, target: PortalTarget, label?: string) =>
      openPortal(target, typeof label === 'string' ? label : undefined)
    )
    handle(WORKSPACE.takeNavigation, () => takeNavigation())
    handle(WORKSPACE.inbox, (_e, view: InboxView) => inboxItems(view))
    handle(WORKSPACE.markInbox, (_e, keys: string[], change: InboxMark) =>
      markInbox(Array.isArray(keys) ? keys : [], change ?? {})
    )
    handle(WORKSPACE.decide, (_e, input: DecideInput) => decide(input))
    handle(WORKSPACE.agent, (_e, slug: string) => agentDetail(String(slug)))
    handle(WORKSPACE.agentAction, (_e, slug: string, action: AgentAction) => agentAction(String(slug), action))
    handle(WORKSPACE.openInVscode, (_e, slug: string) => openInVscode(String(slug)))
    handle(WORKSPACE.followedTasks, (_e, sessionId: string) => followedTasks(String(sessionId)))
    handle(WORKSPACE.setFollow, (_e, taskId: number, change: FollowChange) => {
      if (Number.isInteger(taskId) && change && typeof change === 'object') setFollow(taskId, change)
    })
    handle(WORKSPACE.openTaskFile, (_e, fileId: number, reveal?: boolean) => {
      if (!Number.isInteger(fileId) || fileId <= 0) throw new Error('Arquivo inválido.')
      return openTaskFile(fileId, reveal === true)
    })
    bus.on('session:tool-result', onToolResult)
    start(ctx)
    startFollowing(agentName, (title, body, sessionId) => notifyAway(ctx, title, body, sessionId))
  },
  dispose() {
    stopFollowing()
    stop()
  }
}
