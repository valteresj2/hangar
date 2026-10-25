// Windows policy for the platform connection: HKLM, then HKCU, \Software\Policies\Hangar with the REG_SZ values
// PlatformUrl and Mode. Read with `reg query` (no native module); a missing key just means "no policy".
import { execFile } from 'node:child_process'
import type { PlatformMode } from '../../../shared/features/platform'

export const POLICY_KEYS = {
  machine: 'HKLM\\Software\\Policies\\Hangar',
  user: 'HKCU\\Software\\Policies\\Hangar'
} as const

export interface PolicyValues {
  url?: string
  mode?: PlatformMode
}

export interface Policy {
  url?: { value: string; scope: 'machine' | 'user' }
  mode?: { value: PlatformMode; scope: 'machine' | 'user' }
}

/** Runs `reg query <key>`; resolves to its stdout, or '' when the key does not exist or reg fails. */
export type RegQuery = (key: string) => Promise<string>

export const regQuery: RegQuery = (key) =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('')
    execFile('reg', ['query', key], { windowsHide: true, timeout: 10_000 }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })

export function parseMode(raw: string | undefined): PlatformMode | undefined {
  const v = raw?.trim().toLowerCase()
  return v === 'off' || v === 'optional' || v === 'required' ? v : undefined
}

/** Normalizes a platform URL: http(s) only, no query/fragment/credentials, no trailing slash. undefined if invalid. */
export function normalizeUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return undefined
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * Parses the output of `reg query` for one key. Lines look like
 * `    PlatformUrl    REG_SZ    https://hangar.example.com`; names are matched case-insensitively.
 */
export function parseRegQuery(output: string): PolicyValues {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S.*?)\s+REG_(?:SZ|EXPAND_SZ)(?:\s+(.*))?$/.exec(line)
    if (m) values.set(m[1].toLowerCase(), (m[2] ?? '').trim())
  }
  const out: PolicyValues = {}
  const url = normalizeUrl(values.get('platformurl'))
  if (url) out.url = url
  const mode = parseMode(values.get('mode'))
  if (mode) out.mode = mode
  return out
}

/** Reads both keys; for each value the machine policy wins over the user policy. */
export async function readPolicy(query: RegQuery = regQuery): Promise<Policy> {
  const [machine, user] = await Promise.all([
    query(POLICY_KEYS.machine).then(parseRegQuery),
    query(POLICY_KEYS.user).then(parseRegQuery)
  ])
  const policy: Policy = {}
  if (machine.url) policy.url = { value: machine.url, scope: 'machine' }
  else if (user.url) policy.url = { value: user.url, scope: 'user' }
  if (machine.mode) policy.mode = { value: machine.mode, scope: 'machine' }
  else if (user.mode) policy.mode = { value: user.mode, scope: 'user' }
  return policy
}
