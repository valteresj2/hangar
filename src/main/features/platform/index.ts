// Feature "platform" — main process side. Owned by the platform agent.
// Connection to an Agent Hangar platform (docs/platform/app-api-phase1.md): Windows policy, OAuth loopback login,
// encrypted tokens with rotating refresh, device registration and a heartbeat every 15 min.
import { PLATFORM, type PlatformConfigPatch } from '../../../shared/features/platform'
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import { cancelConnect, connect, disconnect, getState, refresh, setConfig, start, stop } from './controller'

export const platformFeature: Feature = {
  name: 'platform',
  async register(ctx) {
    handle(PLATFORM.state, () => getState())
    handle(PLATFORM.setConfig, (_e, patch: PlatformConfigPatch) => setConfig(patch ?? {}))
    handle(PLATFORM.connect, () => connect())
    handle(PLATFORM.cancelConnect, () => cancelConnect())
    handle(PLATFORM.disconnect, () => disconnect())
    handle(PLATFORM.refresh, () => refresh())
    // Policy and tokens are read before any window opens, so `required` is enforced from the first frame.
    await start(ctx)
  },
  dispose() {
    stop()
  }
}
