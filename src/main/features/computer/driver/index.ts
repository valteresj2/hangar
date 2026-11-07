// Picks the driver of this system: Windows (C# helper), macOS (Swift helper), Linux (X11 tools), or the pretend
// computer of the tests (HANGAR_COMPUTER_DRIVER=fake).
import type { OsKind } from '../guard'
import { LinuxDriver } from './linux'
import { MacDriver } from './macos'
import type { ComputerDriver } from './types'
import { WindowsDriver } from './windows'

export function currentOs(): OsKind | undefined {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : undefined
}

export function osLabel(os: OsKind | undefined): string {
  return os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'win32' ? 'Windows' : String(process.platform)
}

/** launcher: opens an executable, app bundle or shortcut ('' when it worked, else the error). */
export function createDriver(os: OsKind, dir: string, launcher: (target: string) => Promise<string>): ComputerDriver {
  if (os === 'darwin') return new MacDriver(dir, launcher)
  if (os === 'linux') return new LinuxDriver()
  return new WindowsDriver(dir, launcher)
}

/** A limitation of this computer's driver to show in the panel (Wayland, no AT-SPI…), if any. */
export function driverNotice(d: ComputerDriver): string | undefined {
  return (d as { notice?: string }).notice
}
