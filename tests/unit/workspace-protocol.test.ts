// Registration of `hangar://` (src/main/features/workspace/protocol.ts and api.ts): a stable executable for each
// packaging — the Windows portable's real .exe (PORTABLE_EXECUTABLE_FILE, not the temp folder it extracts to) and the
// AppImage file (APPIMAGE, not its per-run mount) — and no registration from dev or e2e runs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { protocolClient, type ProtocolContext } from '../../src/main/features/workspace/protocol'

const { setAsDefaultProtocolClient, electronApp } = vi.hoisted(() => {
  const setAsDefaultProtocolClient = vi.fn((..._args: unknown[]) => true)
  return { setAsDefaultProtocolClient, electronApp: { isPackaged: true, setAsDefaultProtocolClient } }
})
vi.mock('electron', () => ({ app: electronApp, default: { app: electronApp } }))
// api.ts routes links through the controller; registering the protocol never touches it.
vi.mock('../../src/main/features/workspace/controller', () => ({ navigate: vi.fn() }))

const PORTABLE = 'C:\\Users\\ana\\Downloads\\Hangar-0.2.0-portable.exe'
const TEMP_EXE = 'C:\\Users\\ana\\AppData\\Local\\Temp\\2abc\\Hangar.exe'
const APPIMAGE = '/home/ana/Apps/Hangar-0.2.0-linux-x86_64.AppImage'
const MOUNT_EXE = '/tmp/.mount_HangarXyZ/hangar'

const ctx = (patch: Partial<ProtocolContext>): ProtocolContext => ({
  packaged: true,
  platform: 'win32',
  env: {},
  argv: [TEMP_EXE],
  execPath: TEMP_EXE,
  ...patch
})

describe('protocolClient', () => {
  it('Windows portable: the real .exe, not the temp folder it runs from', () => {
    expect(protocolClient(ctx({ env: { PORTABLE_EXECUTABLE_FILE: PORTABLE } }))).toEqual({ path: PORTABLE })
  })

  it('AppImage: the AppImage file, not its mount point', () => {
    expect(
      protocolClient(ctx({ platform: 'linux', env: { APPIMAGE }, argv: [MOUNT_EXE], execPath: MOUNT_EXE }))
    ).toEqual({ path: APPIMAGE })
  })

  it("installed (NSIS, .deb, mac): Electron's default", () => {
    expect(protocolClient(ctx({}))).toEqual({})
    expect(protocolClient(ctx({ platform: 'linux', execPath: '/opt/Hangar/hangar' }))).toEqual({})
    expect(
      protocolClient(ctx({ platform: 'darwin', execPath: '/Applications/Hangar.app/Contents/MacOS/Hangar' }))
    ).toEqual({})
    // Each variable only means something on its own platform.
    expect(protocolClient(ctx({ platform: 'linux', env: { PORTABLE_EXECUTABLE_FILE: PORTABLE } }))).toEqual({})
    expect(protocolClient(ctx({ platform: 'win32', env: { APPIMAGE } }))).toEqual({})
  })

  it('dev runs register only when asked; e2e runs never', () => {
    const dev = {
      packaged: false,
      argv: ['electron.exe', '.'],
      execPath: 'C:\\repo\\node_modules\\electron\\electron.exe'
    }
    expect(protocolClient(ctx(dev))).toBeUndefined()
    expect(protocolClient(ctx({ ...dev, env: { HANGAR_DEV_PROTOCOL: '1' } }))).toEqual({
      path: dev.execPath,
      args: [expect.stringMatching(/\S/)]
    })
    expect(protocolClient(ctx({ env: { HANGAR_E2E: '1', PORTABLE_EXECUTABLE_FILE: PORTABLE } }))).toBeUndefined()
  })
})

describe('registerProtocol', () => {
  const env = { ...process.env }
  const platform = process.platform
  const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

  afterEach(() => {
    process.env = { ...env }
    setPlatform(platform)
    setAsDefaultProtocolClient.mockClear()
  })

  const run = async (p: NodeJS.Platform, vars: Record<string, string>) => {
    process.env = { ...env, ...vars }
    delete process.env['HANGAR_E2E']
    setPlatform(p)
    const { registerProtocol } = await import('../../src/main/features/workspace/api')
    registerProtocol()
  }

  it('Windows portable registers PORTABLE_EXECUTABLE_FILE', async () => {
    await run('win32', { PORTABLE_EXECUTABLE_FILE: PORTABLE })
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith('hangar', PORTABLE, [])
  })

  it('AppImage registers APPIMAGE', async () => {
    await run('linux', { APPIMAGE })
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith('hangar', APPIMAGE, [])
  })

  it('an installed app keeps the default', async () => {
    delete env['PORTABLE_EXECUTABLE_FILE']
    delete env['APPIMAGE']
    await run('win32', {})
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith('hangar')
  })
})
