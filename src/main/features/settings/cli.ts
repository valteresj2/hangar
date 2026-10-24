// Locating and running the Claude Code CLI.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settings } from '../../core/store'
import type { AuthStatus, CliInfo, CliResult } from '../../../shared/features/settings'

const isWin = process.platform === 'win32'

let detected: string | undefined

function exec(file: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<CliResult> {
  // .cmd/.bat shims (npm installs) can only be started through a shell on Windows.
  const shell = isWin && /\.(cmd|bat)$/i.test(file)
  const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  return new Promise((resolve) => {
    execFile(
      shell ? quote(file) : file,
      shell ? args.map(quote) : args,
      {
        cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir(),
        timeout: opts.timeout ?? 60_000,
        windowsHide: true,
        shell,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        resolve({
          ok: !err,
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (err && !stdout ? err.message : '')
        })
      }
    )
  })
}

/** Finds `claude` on PATH (plus the default native-install location). */
async function detectClaude(): Promise<string | undefined> {
  if (detected && existsSync(detected)) return detected
  const res = await exec(isWin ? 'where.exe' : 'which', isWin ? ['claude'] : ['-a', 'claude'], { timeout: 10_000 })
  const candidates = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (isWin) {
    // `where` also lists the extension-less shell script; prefer something Windows can execute.
    candidates.sort((a, b) => rank(a) - rank(b))
    candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'claude'))
  }
  detected = candidates.find((c) => existsSync(c) && (!isWin || rank(c) < 3))
  return detected
}

function rank(path: string): number {
  if (/\.exe$/i.test(path)) return 0
  if (/\.(cmd|bat)$/i.test(path)) return 1
  return 3
}

/** The executable to use: the Settings override when set, otherwise auto-detected. */
export async function claudePath(): Promise<{ path?: string; fromOverride: boolean }> {
  const override = settings().get().claudeExecutablePath?.trim()
  if (override) return { path: override, fromOverride: true }
  return { path: await detectClaude(), fromOverride: false }
}

export async function runClaude(args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<CliResult> {
  const { path } = await claudePath()
  if (!path) return { ok: false, code: null, stdout: '', stderr: 'Claude Code CLI não encontrado no PATH.' }
  return exec(path, args, opts)
}

export async function cliInfo(): Promise<CliInfo> {
  const { path, fromOverride } = await claudePath()
  if (!path) return { fromOverride, error: 'Claude Code CLI não encontrado no PATH.' }
  if (!existsSync(path)) return { path, fromOverride, error: 'Arquivo não encontrado.' }
  const res = await exec(path, ['--version'], { timeout: 20_000 })
  if (!res.ok) return { path, fromOverride, error: res.stderr.trim() || 'Falha ao executar --version.' }
  return { path, fromOverride, version: res.stdout.trim() }
}

export async function authStatus(): Promise<AuthStatus> {
  const res = await runClaude(['auth', 'status', '--json'], { timeout: 30_000 })
  const text = res.stdout.trim()
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
    const str = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : undefined)
    return {
      loggedIn: json.loggedIn === true,
      authMethod: str('authMethod'),
      subscriptionType: str('subscriptionType'),
      email: str('email'),
      orgName: str('orgName')
    }
  } catch {
    return { loggedIn: false, error: (res.stderr || res.stdout).trim() || 'Não foi possível ler o status de login.' }
  }
}
