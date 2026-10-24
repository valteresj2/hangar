// MCP server management through `claude mcp ...`.
// Listing parses the CLI's human-readable output (it has no --json) and enriches it with
// the scope read from the config files. All writes go through the CLI.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliResult, McpAddInput, McpHealth, McpListResult, McpScope, McpServer } from '../../../shared/features/settings'
import { runClaude } from './cli'

type ServerConfig = { type?: string; command?: string; url?: string; env?: object; headers?: object }
type ServerMap = Record<string, ServerConfig>

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** name -> (scope, config) from ~/.claude.json and <cwd>/.mcp.json. Local wins over project wins over user. */
function configuredServers(cwd: string | undefined): Map<string, { scope: McpScope; config: ServerConfig }> {
  const out = new Map<string, { scope: McpScope; config: ServerConfig }>()
  const add = (servers: unknown, scope: McpScope) => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, config] of Object.entries(servers as ServerMap)) out.set(name, { scope, config })
  }
  const root = readJson(join(homedir(), '.claude.json'))
  add(root?.mcpServers, 'user')
  if (cwd) {
    add(readJson(join(cwd, '.mcp.json'))?.mcpServers, 'project')
    const projects = (root?.projects ?? {}) as Record<string, { mcpServers?: ServerMap }>
    for (const [path, project] of Object.entries(projects)) {
      if (norm(path) === norm(cwd)) add(project.mcpServers, 'local')
    }
  }
  return out
}

const HEALTH: Record<string, McpHealth> = { '✔': 'connected', '✓': 'connected', '✘': 'failed', '✗': 'failed', '!': 'needs-auth', '⏸': 'pending' }

/** Parses lines like `name: target (HTTP) - ✔ Connected`. */
export function parseMcpList(raw: string): Omit<McpServer, 'scope'>[] {
  const servers: Omit<McpServer, 'scope'>[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(.+?): (.*) - ([✔✓✘✗!⏸⚠])\s*(.*)$/u.exec(line.trim())
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

export async function mcpList(cwd?: string): Promise<McpListResult> {
  const res = await runClaude(['mcp', 'list'], { cwd, timeout: 120_000 })
  const raw = (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim()
  if (!res.ok && !res.stdout) return { ok: false, servers: [], raw, error: res.stderr.trim() || 'Falha ao executar claude mcp list.' }
  const configured = configuredServers(cwd)
  const servers: McpServer[] = parseMcpList(res.stdout).map((s) => {
    const cfg = configured.get(s.name)
    const scope: McpScope = cfg?.scope ?? (s.name.startsWith('claude.ai ') ? 'claude.ai' : 'unknown')
    const config = cfg?.config
    return {
      ...s,
      scope,
      transport: s.transport ?? config?.type ?? (config?.command ? 'stdio' : config?.url ? 'http' : undefined),
      envKeys: config?.env ? Object.keys(config.env) : undefined,
      headerKeys: config?.headers ? Object.keys(config.headers) : undefined
    }
  })
  return { ok: true, servers, raw }
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
  return runClaude(['mcp', 'add-json', '-s', input.scope, name, JSON.stringify(config)], { cwd: input.cwd, timeout: 60_000 })
}

export function mcpRemove(name: string, scope?: string, cwd?: string): Promise<CliResult> {
  const args = ['mcp', 'remove', name]
  if (scope === 'local' || scope === 'user' || scope === 'project') args.push('-s', scope)
  return runClaude(args, { cwd, timeout: 60_000 })
}
