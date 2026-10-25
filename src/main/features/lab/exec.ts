// What a harness can make run on the user's machine, and how it differs between two harness trees.
//
// Adopting a harness (or running a manual round with one) is code execution, not just new instructions:
// .claude/settings.json hooks and helper commands run shell commands, permission rules widen what Claude may do
// without asking, `env` reaches every tool, and scripts under .claude/scripts or skills are run by those hooks and
// skills. Slash commands and skills can also embed !`command` lines that run when invoked.
import { createHash } from 'node:crypto'
import type { HarnessTree } from '../../../shared/harness'
import type { ExecChange, ExecReview } from '../../../shared/features/lab'

const SETTINGS = '.claude/settings.json'
/** Settings keys whose string value is a command Claude Code runs. */
const COMMAND_KEYS = new Set([
  'command',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'url'
])
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|exe|dll|jar)$/i
const INLINE_COMMAND = /!`([^`\n]+)`/g

/** `path → command` for every command-bearing string in a settings document (hooks, statusLine, helpers…). */
function commandsIn(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) value.forEach((v, i) => commandsIn(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${key}` : key
      if (typeof v === 'string' && COMMAND_KEYS.has(key)) out.set(p, v)
      else commandsIn(v, p, out)
    }
  }
}

interface SettingsSurface {
  ok: boolean
  commands: Map<string, string>
  allow: Set<string>
  env: Map<string, string>
  other: Map<string, string>
}

function surfaceOf(source: string | undefined): SettingsSurface {
  const empty: SettingsSurface = { ok: true, commands: new Map(), allow: new Set(), env: new Map(), other: new Map() }
  if (source === undefined) return empty
  let doc: Record<string, any>
  try {
    doc = JSON.parse(source)
  } catch {
    return { ...empty, ok: false }
  }
  commandsIn(doc, '', empty.commands)
  for (const rule of Array.isArray(doc?.permissions?.allow) ? doc.permissions.allow : []) {
    if (typeof rule === 'string') empty.allow.add(rule)
  }
  for (const [k, v] of Object.entries(doc?.env && typeof doc.env === 'object' ? doc.env : {}))
    empty.env.set(k, String(v))
  const mode = doc?.permissions?.defaultMode
  if (typeof mode === 'string') empty.other.set('permissions.defaultMode', mode)
  for (const key of [
    'enableAllProjectMcpServers',
    'enabledMcpjsonServers',
    'disableAllHooks',
    'additionalDirectories'
  ]) {
    if (doc?.[key] !== undefined) empty.other.set(key, JSON.stringify(doc[key]))
  }
  for (const dir of Array.isArray(doc?.permissions?.additionalDirectories)
    ? doc.permissions.additionalDirectories
    : []) {
    empty.other.set(`permissions.additionalDirectories:${dir}`, String(dir))
  }
  return empty
}

function diffMaps(
  base: Map<string, string>,
  next: Map<string, string>,
  emit: (key: string, change: ExecChange['change'], value: string) => void
): void {
  for (const [k, v] of next) {
    if (!base.has(k)) emit(k, 'added', v)
    else if (base.get(k) !== v) emit(k, 'modified', v)
  }
  for (const [k, v] of base) if (!next.has(k)) emit(k, 'removed', v)
}

function isScriptPath(path: string): boolean {
  if (path.startsWith('.claude/scripts/')) return true
  return /^\.claude\/skills\/[^/]+\/./.test(path) && (path.includes('/scripts/') || SCRIPT_EXT.test(path))
}

function inlineCommands(source: string | undefined): Set<string> {
  return new Set([...(source ?? '').matchAll(INLINE_COMMAND)].map((m) => m[1].trim()))
}

/** Executable changes from `base` to `next` (both harness trees), most dangerous first. */
export function execChanges(base: HarnessTree, next: HarnessTree): ExecChange[] {
  const out: ExecChange[] = []

  if (base[SETTINGS] !== next[SETTINGS]) {
    const a = surfaceOf(base[SETTINGS])
    const b = surfaceOf(next[SETTINGS])
    if (!b.ok) {
      out.push({
        path: SETTINGS,
        change: 'modified',
        kind: 'command',
        detail: 'settings.json não é um JSON válido; revise o arquivo inteiro.'
      })
    }
    diffMaps(a.commands, b.commands, (key, change, cmd) =>
      out.push({ path: SETTINGS, change, kind: key.startsWith('hooks') ? 'hook' : 'command', detail: `${key}: ${cmd}` })
    )
    for (const rule of b.allow)
      if (!a.allow.has(rule))
        out.push({ path: SETTINGS, change: 'added', kind: 'permission', detail: `permissions.allow: ${rule}` })
    diffMaps(a.other, b.other, (key, change, value) =>
      out.push({ path: SETTINGS, change, kind: 'permission', detail: `${key} = ${value}` })
    )
    diffMaps(a.env, b.env, (key, change, value) =>
      out.push({ path: SETTINGS, change, kind: 'env', detail: `env.${key} = ${value}` })
    )
  }

  const paths = new Set([...Object.keys(base), ...Object.keys(next)])
  for (const path of [...paths].sort()) {
    if (path === SETTINGS || base[path] === next[path]) continue
    const change: ExecChange['change'] = !(path in base) ? 'added' : !(path in next) ? 'removed' : 'modified'
    if (isScriptPath(path)) {
      out.push({ path, change, kind: 'script', detail: path })
    } else if (path.endsWith('.md') && change !== 'removed') {
      const before = inlineCommands(base[path])
      for (const cmd of inlineCommands(next[path])) {
        if (!before.has(cmd)) out.push({ path, change: 'added', kind: 'inline-command', detail: `!\`${cmd}\`` })
      }
    }
  }

  const rank: Record<ExecChange['kind'], number> = {
    hook: 0,
    command: 1,
    script: 2,
    'inline-command': 3,
    permission: 4,
    env: 5
  }
  return out.sort((x, y) => rank[x.kind] - rank[y.kind])
}

/** Hash of the list; empty when nothing new would run (removals alone need no confirmation). */
export function fingerprintOf(changes: ExecChange[]): string {
  if (!changes.some((c) => c.change !== 'removed')) return ''
  return createHash('sha256').update(JSON.stringify(changes)).digest('hex').slice(0, 32)
}

export function execReview(base: HarnessTree, next: HarnessTree): ExecReview {
  const changes = execChanges(base, next)
  return { changes, fingerprint: fingerprintOf(changes) }
}
