// MCP server management through `claude mcp ...`.
// Listing parses the CLI's human-readable output (it has no --json) and enriches it with
// the scope read from the config files. Adding and removing go through the CLI.
//
// Switching servers off uses the mechanisms Claude Code itself reads (the CLI has no command for it):
// - `disabledMcpServers` in ~/.claude.json projects[<folder>]: per-project opt-out, the list /mcp toggles write;
// - `disabledMcpjsonServers` / `enabledMcpjsonServers` in <folder>/.claude/settings.local.json, for .mcp.json servers
//   (current CLI versions migrate the old copies of these lists out of ~/.claude.json into that file);
// - for user-scope servers "everywhere": `claude mcp remove`, keeping the config in Hangar to re-add with add-json.

import { app } from 'electron'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CliResult,
  McpAddInput,
  McpHealth,
  McpListResult,
  McpLog,
  McpScope,
  McpServer,
  McpToggleInput,
  McpToggleResult
} from '../../../shared/features/settings'
import { runClaude } from './cli'

type ServerConfig = { type?: string; command?: string; args?: string[]; url?: string; env?: object; headers?: object }
type ServerMap = Record<string, ServerConfig>
type ProjectEntry = {
  mcpServers?: ServerMap
  disabledMcpServers?: string[]
  disabledMcpjsonServers?: string[]
  enabledMcpjsonServers?: string[]
}
type ClaudeJson = { mcpServers?: ServerMap; projects?: Record<string, ProjectEntry> }

function readJson<T = Record<string, unknown>>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.hangar-tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const claudeConfigDir = () => process.env['CLAUDE_CONFIG_DIR'] || homedir()
const claudeJsonFile = () => join(claudeConfigDir(), '.claude.json')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Project entries of ~/.claude.json for a folder (the CLI has used both slash styles as keys over time). */
function projectEntries(root: ClaudeJson, cwd: string): ProjectEntry[] {
  return Object.entries(root.projects ?? {})
    .filter(([path]) => norm(path) === norm(cwd))
    .map(([, entry]) => entry)
}

/** name -> (scope, config) from ~/.claude.json and <cwd>/.mcp.json. Local wins over project wins over user. */
function configuredServers(
  root: ClaudeJson | undefined,
  cwd: string | undefined
): Map<string, { scope: McpScope; config: ServerConfig }> {
  const out = new Map<string, { scope: McpScope; config: ServerConfig }>()
  const add = (servers: unknown, scope: McpScope) => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, config] of Object.entries(servers as ServerMap)) out.set(name, { scope, config })
  }
  add(root?.mcpServers, 'user')
  if (cwd) {
    add(readJson(join(cwd, '.mcp.json'))?.mcpServers, 'project')
    for (const entry of root ? projectEntries(root, cwd) : []) add(entry.mcpServers, 'local')
  }
  return out
}

const localSettingsFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json')

/** `disabledMcpjsonServers` from shared/user settings files, which Hangar reports but does not edit. */
function settingsRejected(cwd: string): Set<string> {
  const files = [join(claudeConfigDir(), '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json')]
  return new Set(files.flatMap((f) => strings(readJson(f)?.disabledMcpjsonServers)))
}

// ---- Servers switched off "everywhere" by Hangar ----

type HangarDisabled = Record<string, { config: ServerConfig; disabledAt: number }>

function hangarDisabledFile(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'settings')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'mcp-disabled.json')
}

const readHangarDisabled = (): HangarDisabled => readJson<HangarDisabled>(hangarDisabledFile()) ?? {}

// ---- Listing ----

const HEALTH: Record<string, McpHealth> = {
  '✔': 'connected',
  '✓': 'connected',
  '✘': 'failed',
  '✗': 'failed',
  '!': 'needs-auth',
  '⏸': 'pending',
  '⊘': 'disabled'
}

/** Parses lines like `name: target (HTTP) - ✔ Connected`. */
export function parseMcpList(raw: string): Omit<McpServer, 'scope' | 'canDisableEverywhere'>[] {
  const servers: Omit<McpServer, 'scope' | 'canDisableEverywhere'>[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(.+?): (.*) - ([✔✓✘✗!⏸⊘⚠])\s*(.*)$/u.exec(line.trim())
    if (!m) continue
    let target = m[2].trim()
    let transport: string | undefined
    const t = /\s\((HTTP|SSE|stdio|WS|WebSocket)\)$/i.exec(target)
    if (t) {
      transport = t[1].toLowerCase()
      target = target.slice(0, t.index).trim()
    }
    servers.push({ name: m[1].trim(), target, transport, health: HEALTH[m[3]] ?? 'unknown', statusText: m[4].trim() })
  }
  return servers
}

const describe = (c: ServerConfig) => (c.url ? c.url : [c.command, ...(c.args ?? [])].filter(Boolean).join(' '))
const transportOf = (c: ServerConfig | undefined) => c?.type ?? (c?.command ? 'stdio' : c?.url ? 'http' : undefined)

export async function mcpList(cwd?: string): Promise<McpListResult> {
  const res = await runClaude(['mcp', 'list'], { cwd, timeout: 120_000 })
  const raw = (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim()
  if (!res.ok && !res.stdout)
    return { ok: false, servers: [], raw, cwd, error: res.stderr.trim() || 'Falha ao executar claude mcp list.' }

  const root = readJson<ClaudeJson>(claudeJsonFile())
  const configured = configuredServers(root, cwd)
  const entries = cwd && root ? projectEntries(root, cwd) : []
  const disabledJson = new Set([
    ...strings(cwd ? readJson(localSettingsFile(cwd))?.disabledMcpjsonServers : undefined),
    ...entries.flatMap((e) => strings(e.disabledMcpjsonServers))
  ])
  const rejected = cwd ? settingsRejected(cwd) : new Set<string>()

  const finish = (s: Omit<McpServer, 'canDisableEverywhere' | 'projectToggle'>): McpServer => {
    const config = configured.get(s.name)?.config
    const server: McpServer = {
      ...s,
      transport: s.transport ?? transportOf(config),
      envKeys: config?.env ? Object.keys(config.env) : undefined,
      headerKeys: config?.headers ? Object.keys(config.headers) : undefined,
      canDisableEverywhere: s.scope === 'user'
    }
    if (cwd && server.disabledBy !== 'settings' && server.disabledBy !== 'hangar') {
      server.projectToggle = server.scope === 'project' ? 'mcpjson' : 'project'
    }
    return server
  }

  const servers: McpServer[] = parseMcpList(res.stdout).map((s) => {
    const scope: McpScope = configured.get(s.name)?.scope ?? (s.name.startsWith('claude.ai ') ? 'claude.ai' : 'unknown')
    return finish({ ...s, scope, disabledBy: s.health === 'disabled' ? 'project' : undefined })
  })

  // `mcp list` omits rejected .mcp.json servers; list every configured server anyway.
  const seen = new Set(servers.map((s) => s.name))
  for (const [name, { scope, config }] of configured) {
    if (seen.has(name)) continue
    const disabledBy = rejected.has(name) ? 'settings' : disabledJson.has(name) ? 'mcpjson' : undefined
    servers.push(
      finish({
        name,
        scope,
        target: describe(config),
        health: disabledBy ? 'disabled' : 'unknown',
        statusText:
          disabledBy === 'settings'
            ? 'Rejected (see disabledMcpjsonServers in settings)'
            : disabledBy
              ? 'Disabled for this project'
              : '',
        disabledBy
      })
    )
    seen.add(name)
  }

  for (const [name, { config }] of Object.entries(readHangarDisabled())) {
    if (seen.has(name)) continue
    servers.push({
      name,
      scope: 'user',
      target: describe(config),
      transport: transportOf(config),
      health: 'disabled',
      statusText: 'Disabled everywhere by Hangar',
      disabledBy: 'hangar',
      envKeys: config.env ? Object.keys(config.env) : undefined,
      headerKeys: config.headers ? Object.keys(config.headers) : undefined,
      canDisableEverywhere: true
    })
  }
  return { ok: true, servers, raw, cwd }
}

export function mcpGet(name: string, cwd?: string): Promise<CliResult> {
  return runClaude(['mcp', 'get', name], { cwd, timeout: 60_000 })
}

export async function mcpAdd(input: McpAddInput): Promise<CliResult> {
  const name = input.name.trim()
  const fail = (msg: string): CliResult => ({ ok: false, code: null, stdout: '', stderr: msg })
  if (!/^[\w.-]+$/.test(name)) return fail('Nome inválido: use letras, números, ponto, hífen ou sublinhado.')
  if (input.scope !== 'user' && !input.cwd) return fail('Escolha a pasta do projeto para os escopos local e projeto.')

  let config: Record<string, unknown>
  if (input.transport === 'stdio') {
    if (!input.command?.trim()) return fail('Informe o comando.')
    config = { type: 'stdio', command: input.command.trim(), args: input.args ?? [] }
    if (input.env && Object.keys(input.env).length) config.env = input.env
  } else {
    if (!/^https?:\/\//i.test(input.url?.trim() ?? '')) return fail('Informe uma URL http(s).')
    config = { type: input.transport, url: input.url!.trim() }
    if (input.headers && Object.keys(input.headers).length) config.headers = input.headers
  }
  // add-json takes the whole config as one argument, which avoids the variadic -e/-H parsing pitfalls of `mcp add`.
  return runClaude(['mcp', 'add-json', '-s', input.scope, name, JSON.stringify(config)], {
    cwd: input.cwd,
    timeout: 60_000
  })
}

export function mcpRemove(name: string, scope?: string, cwd?: string): Promise<CliResult> {
  const args = ['mcp', 'remove', name]
  if (scope === 'local' || scope === 'user' || scope === 'project') args.push('-s', scope)
  return runClaude(args, { cwd, timeout: 60_000 })
}

// ---- Enable / disable ----

type ListField = 'disabledMcpServers' | 'disabledMcpjsonServers' | 'enabledMcpjsonServers'

/** Adds or removes `name` in list fields of the folder's project entry in ~/.claude.json (re-read right before writing). */
function editProjectLists(cwd: string, changes: { field: ListField; present: boolean }[], name: string): void {
  const file = claudeJsonFile()
  const root = readJson<ClaudeJson>(file)
  if (!root) throw new Error(`Não foi possível ler ${file}.`)
  root.projects ??= {}
  let entries = projectEntries(root, cwd)
  if (!entries.length) {
    // Current CLI versions key projects by the forward-slash path.
    const entry: ProjectEntry = {}
    root.projects[cwd.replace(/\\/g, '/')] = entry
    entries = [entry]
  }
  for (const entry of entries) {
    for (const { field, present } of changes) {
      const list = strings(entry[field]).filter((n) => n !== name)
      entry[field] = present ? [...list, name] : list
    }
  }
  writeJsonAtomic(file, root)
}

/** Approves or rejects a .mcp.json server in <cwd>/.claude/settings.local.json and drops legacy copies in ~/.claude.json. */
function editLocalSettingsLists(cwd: string, name: string, enabled: boolean): void {
  const file = localSettingsFile(cwd)
  const current = readJson<Record<string, unknown>>(file)
  if (existsSync(file) && !current) throw new Error(`${file} não é um JSON válido; corrija o arquivo antes.`)
  const next: Record<string, unknown> = { ...current }
  const update = (field: string, present: boolean) => {
    const list = strings(next[field]).filter((n) => n !== name)
    next[field] = present ? [...list, name] : list
  }
  update('disabledMcpjsonServers', !enabled)
  update('enabledMcpjsonServers', enabled)
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeJsonAtomic(file, next)

  const root = readJson<ClaudeJson>(claudeJsonFile())
  const legacy = root
    ? projectEntries(root, cwd).some(
        (e) => strings(e.disabledMcpjsonServers).includes(name) || strings(e.enabledMcpjsonServers).includes(name)
      )
    : false
  if (legacy) {
    editProjectLists(
      cwd,
      [
        { field: 'disabledMcpjsonServers', present: false },
        { field: 'enabledMcpjsonServers', present: false }
      ],
      name
    )
  }
}

export async function mcpSetEnabled(input: McpToggleInput): Promise<McpToggleResult> {
  const { name, enabled, mechanism, cwd } = input
  try {
    if (mechanism === 'project' || mechanism === 'mcpjson') {
      if (!cwd) return { ok: false, message: 'Escolha a pasta do projeto.' }
      if (mechanism === 'project') {
        editProjectLists(cwd, [{ field: 'disabledMcpServers', present: !enabled }], name)
        return {
          ok: true,
          message: enabled
            ? 'Ligado neste projeto.'
            : 'Desligado neste projeto (disabledMcpServers no ~/.claude.json, o mesmo que o /mcp usa).'
        }
      }
      editLocalSettingsLists(cwd, name, enabled)
      return {
        ok: true,
        message: enabled
          ? 'Aprovado nesta pasta (enabledMcpjsonServers em .claude/settings.local.json). Se a pasta ainda não for confiável, abra o `claude` nela uma vez.'
          : 'Rejeitado nesta pasta (disabledMcpjsonServers em .claude/settings.local.json).'
      }
    }

    // mechanism === 'hangar': user-scope servers, everywhere.
    const store = readHangarDisabled()
    if (!enabled) {
      const config = readJson<ClaudeJson>(claudeJsonFile())?.mcpServers?.[name]
      if (!config) return { ok: false, message: `"${name}" não é um servidor do escopo usuário.` }
      writeJsonAtomic(hangarDisabledFile(), { ...store, [name]: { config, disabledAt: Date.now() } })
      const res = await mcpRemove(name, 'user')
      if (!res.ok) {
        writeJsonAtomic(hangarDisabledFile(), store)
        return { ok: false, message: (res.stderr || res.stdout).trim() || 'Falha ao remover.' }
      }
      return {
        ok: true,
        message:
          'Desligado em todos os projetos: removido com `claude mcp remove`; a configuração ficou guardada no Hangar.'
      }
    }
    const entry = store[name]
    if (!entry) return { ok: false, message: 'Configuração guardada não encontrada.' }
    const res = await runClaude(['mcp', 'add-json', '-s', 'user', name, JSON.stringify(entry.config)], {
      timeout: 60_000
    })
    if (!res.ok) return { ok: false, message: (res.stderr || res.stdout).trim() || 'Falha ao adicionar.' }
    const { [name]: _restored, ...rest } = store
    writeJsonAtomic(hangarDisabledFile(), rest)
    return { ok: true, message: 'Ligado de novo: re-adicionado com `claude mcp add-json -s user`.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ---- Logs ----

/** Claude Code's cache folder, where it keeps per-project `mcp-logs-<server>` folders. */
function cacheRoot(): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'claude-cli-nodejs', 'Cache')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'claude-cli-nodejs')
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'claude-cli-nodejs')
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '-')

function newestFile(dir: string): { file: string; mtime: number } | undefined {
  let best: { file: string; mtime: number } | undefined
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      const st = statSync(file)
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs }
    }
  } catch {
    // missing folder
  }
  return best
}

function formatLogLine(line: string): string {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>
    const level = ['error', 'warn', 'info', 'debug'].find((k) => k in entry)
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp.replace('T', ' ').slice(0, 19) : ''
    const value = level ? entry[level] : entry
    const msg = typeof value === 'string' ? value : JSON.stringify(value)
    return `${ts} ${(level ?? 'log').toUpperCase().padEnd(5)} ${msg}`
  } catch {
    return line
  }
}

const LOG_TAIL_BYTES = 256 * 1024

export function mcpLog(name: string, cwd?: string): McpLog {
  const root = cacheRoot()
  const serverDir = `mcp-logs-${sanitize(name)}`
  let dir = join(root, sanitize(cwd ?? homedir()), serverDir)
  let newest = newestFile(dir)
  if (!newest) {
    // Long or 8.3-style paths make the project folder name hard to predict; take the newest log of this server anywhere.
    try {
      for (const project of readdirSync(root)) {
        const candidate = newestFile(join(root, project, serverDir))
        if (candidate && (!newest || candidate.mtime > newest.mtime)) {
          newest = candidate
          dir = join(root, project, serverDir)
        }
      }
    } catch {
      // no cache folder yet
    }
  }
  if (!newest) return { dir, lines: [], truncated: false }

  try {
    const size = statSync(newest.file).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(newest.file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    let lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean)
    if (start > 0) lines = lines.slice(1) // first line is probably cut
    return {
      dir,
      file: newest.file,
      modifiedAt: newest.mtime,
      lines: lines.slice(-1000).map(formatLogLine),
      truncated: start > 0 || lines.length > 1000
    }
  } catch (err) {
    return {
      dir,
      file: newest.file,
      lines: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
