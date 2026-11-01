// Feature "workspace" — main process side. Owned by the workspace agent.
// The member's screens of the Agent Hangar platform in the app (docs/platform/m1-contract.md): Início, Meus
// agentes, Decisões and Caixa de entrada from the member routes (deciding, marking the inbox and acting on the person's
// own agents too), live badges from GET /api/app/events, and `hangar://open/<route>` deep links
// (registered by src/main/index.ts through ./api.ts).
import {
  WORKSPACE,
  type AgentAction,
  type DecideInput,
  type InboxMark,
  type InboxView,
  type PortalTarget,
  type WorkspaceScope
} from '../../../shared/features/workspace'
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import {
  agentAction,
  agentDetail,
  decide,
  getState,
  inboxItems,
  markInbox,
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
    start(ctx)
  },
  dispose() {
    stop()
  }
}
