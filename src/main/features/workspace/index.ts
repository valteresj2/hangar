// Feature "workspace" — main process side. Owned by the workspace agent.
// The member's screens of the Agent Hangar platform in the app (docs/platform/m1-contract.md): Início and Meus
// agentes from the member routes, live badges from GET /api/app/events, and `hangar://open/<route>` deep links
// (registered by src/main/index.ts through ./api.ts).
import { WORKSPACE, type PortalTarget, type WorkspaceScope } from '../../../shared/features/workspace'
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import { getState, openPortal, refresh, start, stop, takeNavigation } from './controller'

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
    start(ctx)
  },
  dispose() {
    stop()
  }
}
