// Windows driver: a small C# helper (helper/HangarDesktopHelper.cs) over Win32 (SendInput, window capture, foreground)
// and UI Automation, speaking JSON lines over stdio. It is compiled on first use with the in-box C# compiler of .NET
// Framework 4.x (present on every Windows 10/11) into <userData>/computer, cached by the source hash: no native npm
// module, no download. Without csc.exe, the same source runs through PowerShell's Add-Type.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import source from './helper/HangarDesktopHelper.cs?raw'
import { HelperDriver } from './helper'

const FRAMEWORK = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const REFS = [
  'System.Web.Extensions.dll',
  'System.Drawing.dll',
  join(FRAMEWORK, 'WPF', 'UIAutomationClient.dll'),
  join(FRAMEWORK, 'WPF', 'UIAutomationTypes.dll'),
  join(FRAMEWORK, 'WPF', 'WindowsBase.dll')
]
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10_000_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

/** Compiles the helper (once per source version) and returns how to start it. */
export async function prepareHelper(dir: string): Promise<{ cmd: string; args: string[] }> {
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const exe = join(dir, `hangar-desktop-helper-${hash}.exe`)
  if (existsSync(exe)) return { cmd: exe, args: [] }
  const cs = join(dir, `HangarDesktopHelper-${hash}.cs`)
  writeFileSync(cs, source, 'utf8')
  const csc = join(FRAMEWORK, 'csc.exe')
  if (existsSync(csc)) {
    const r = await run(csc, ['-nologo', '-target:exe', '-optimize', `-out:${exe}`, ...REFS.map((x) => `-r:${x}`), cs])
    if (r.code === 0 && existsSync(exe)) return { cmd: exe, args: [] }
  }
  // Fallback: PowerShell compiles the same source in memory and runs it.
  const refs = REFS.map((r) => `'${r.replace(/'/g, "''")}'`).join(',')
  const script = `Add-Type -Path '${cs.replace(/'/g, "''")}' -ReferencedAssemblies ${refs}; [Hangar.Helper]::Main(@())`
  return {
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  }
}

/** The Windows driver: the C# helper, compiled on first use. */
export class WindowsDriver extends HelperDriver {
  constructor(dir: string, launcher: (target: string) => Promise<string>) {
    super('windows', dir, prepareHelper, launcher)
  }
}
