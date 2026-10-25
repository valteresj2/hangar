// Which executable `hangar://` links should launch (pure, so every packaging is unit-tested). Electron's default is
// process.execPath, which is not stable for every packaging:
//   Windows portable  the exe extracts itself to a temp folder that goes away on exit: PORTABLE_EXECUTABLE_FILE is
//                     the real .exe the person launched
//   Linux AppImage    the AppImage is mounted at a different path each run: APPIMAGE is the file itself (the link
//                     also needs a hangar.desktop in ~/.local/share/applications, which an AppImage without
//                     desktop integration lacks; see docs/agents/reports/w1-release.md)
//   NSIS / .deb / mac the installer declares the protocol too; registering again at run time does no harm
import { resolve } from 'node:path'

/** Arguments for app.setAsDefaultProtocolClient: none (Electron's default), or an executable (and its args). */
export interface ProtocolClient {
  path?: string
  args?: string[]
}

export interface ProtocolContext {
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  argv: readonly string[]
  execPath: string
}

/**
 * How to register (undefined: do not). Only the installed app registers — a dev run would take the links away from
 * it — unless HANGAR_DEV_PROTOCOL=1; e2e runs never touch the machine's registration.
 */
export function protocolClient(ctx: ProtocolContext): ProtocolClient | undefined {
  const { env } = ctx
  if (env['HANGAR_E2E']) return undefined
  if (ctx.packaged) {
    const portable = env['PORTABLE_EXECUTABLE_FILE']
    if (ctx.platform === 'win32' && portable) return { path: portable }
    const appImage = env['APPIMAGE']
    if (ctx.platform === 'linux' && appImage) return { path: appImage }
    return {}
  }
  if (env['HANGAR_DEV_PROTOCOL'] === '1' && ctx.argv[1]) return { path: ctx.execPath, args: [resolve(ctx.argv[1])] }
  return undefined
}
