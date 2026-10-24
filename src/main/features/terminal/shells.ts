// Detects the shells available on this machine. The first entry is the default.

import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { ShellInfo } from '../../../shared/features/terminal'

function findOnPath(exe: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  return paths.find((p): p is string => !!p && existsSync(p))
}

function windowsShells(): ShellInfo[] {
  const env = process.env
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const shells: ShellInfo[] = []

  const pwsh = firstExisting([
    findOnPath('pwsh.exe'),
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe')
  ])
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] })

  const powershell = firstExisting([join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')])
  if (powershell) shells.push({ id: 'powershell', name: 'Windows PowerShell', path: powershell, args: ['-NoLogo'] })

  const cmd = firstExisting([env.ComSpec, join(systemRoot, 'System32', 'cmd.exe')])
  if (cmd) shells.push({ id: 'cmd', name: 'Prompt de Comando', path: cmd, args: [] })

  // Git Bash: standard install locations, then relative to git.exe on PATH (…\Git\cmd\git.exe).
  // Never System32\bash.exe, which is the WSL launcher.
  const git = findOnPath('git.exe')
  const bash = firstExisting([
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    git && resolve(dirname(git), '..', 'bin', 'bash.exe'),
    git && resolve(dirname(git), '..', '..', 'bin', 'bash.exe')
  ])
  if (bash) shells.push({ id: 'gitbash', name: 'Git Bash', path: bash, args: ['--login', '-i'] })

  return shells
}

function unixShells(): ShellInfo[] {
  const seen = new Set<string>()
  const shells: ShellInfo[] = []
  for (const path of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (!path || seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    const name = path.split('/').pop() ?? path
    shells.push({ id: name, name, path, args: ['-l'] })
  }
  return shells
}

let cached: ShellInfo[] | undefined

export function detectShells(): ShellInfo[] {
  cached ??= process.platform === 'win32' ? windowsShells() : unixShells()
  return cached
}
