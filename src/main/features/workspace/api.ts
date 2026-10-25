// Main-side API of the workspace feature: `hangar://` deep links, for src/main/index.ts (protocol registration,
// `second-instance` on Windows/Linux, `open-url` on macOS).
import { app } from 'electron'
import { DEEP_LINK_MAX, parseDeepLink } from '../../../shared/features/workspace'
import { navigate } from './controller'
import { protocolClient } from './protocol'

export const PROTOCOL = 'hangar'

/** Makes this app the handler of `hangar://` links, with a stable executable for each packaging (./protocol.ts). */
export function registerProtocol(): void {
  const client = protocolClient({
    packaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    execPath: process.execPath
  })
  if (!client) return
  try {
    if (client.path) app.setAsDefaultProtocolClient(PROTOCOL, client.path, client.args ?? [])
    else app.setAsDefaultProtocolClient(PROTOCOL)
  } catch (err) {
    console.warn('[workspace] could not register the hangar:// protocol', err)
  }
}

/** The `hangar://` link among a launch's command-line arguments (Windows/Linux pass it there). */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((a) => typeof a === 'string' && a.length <= DEEP_LINK_MAX && /^hangar:\/\//i.test(a))
}

/**
 * Opens a `hangar://open/<route>` link: native screens in the window (focused), routes not migrated yet in the
 * portal. Anything outside the closed list of routes is refused (false) and only logged.
 */
export function handleDeepLink(url: string): boolean {
  const nav = parseDeepLink(url)
  if (!nav) {
    console.warn(`[workspace] deep link recusado: ${String(url).slice(0, 120)}`)
    return false
  }
  navigate(nav)
  return true
}
