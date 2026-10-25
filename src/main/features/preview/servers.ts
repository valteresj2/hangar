// Dev servers described by `<session dir>/.claude/launch.json`.
// Each started configuration is a child process whose stdout/stderr is kept in a bounded log.
// Once the configured port answers, the server is "ready" and the renderer opens it in a browser tab.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { broadcast } from '../../core/broadcast'
import {
  PREVIEW,
  type LaunchConfigsResult,
  type LaunchConfiguration,
  type LaunchSaveResult,
  type ServerEvent,
  type ServerInfo
} from '../../../shared/features/preview'
import { sessionDir } from './paths'

const MAX_LOG_CHARS = 512 * 1024
const POLL_MS = 700

interface Running {
  info: ServerInfo
  child: ChildProcess
  log: string[]
  logChars: number
  pending: string
  flushTimer?: NodeJS.Timeout
  pollTimer?: NodeJS.Timeout
  stopRequested: boolean
}

const servers = new Map<string, Running>()

// ---- launch.json ----

export function launchPath(dir: string): string {
  return join(dir, '.claude', 'launch.json')
}

/** Removes // and /* *\/ comments and trailing commas, leaving string contents intact. */
function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] !== '}' && text[j] !== ']') out += ch
      i++
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Parses and validates launch.json text. Throws a user-facing (pt-BR) message on error. */
export function parseLaunch(text: string): LaunchConfiguration[] {
  let value: unknown
  try {
    value = JSON.parse(stripJsonc(text))
  } catch (err) {
    throw new Error(`JSON inválido: ${(err as Error).message}`, { cause: err })
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { configurations?: unknown }).configurations)) {
    throw new Error('O arquivo precisa ter um array "configurations".')
  }
  const configs = (value as { configurations: unknown[] }).configurations
  return configs.map((raw, index) => {
    const c = (raw ?? {}) as Record<string, unknown>
    const where = `configurations[${index}]`
    if (typeof c.name !== 'string' || !c.name.trim()) throw new Error(`${where}: "name" é obrigatório.`)
    if (typeof c.runtimeExecutable !== 'string' || !c.runtimeExecutable.trim()) {
      throw new Error(`${where}: "runtimeExecutable" é obrigatório.`)
    }
    if (
      c.runtimeArgs !== undefined &&
      (!Array.isArray(c.runtimeArgs) || c.runtimeArgs.some((a) => typeof a !== 'string'))
    ) {
      throw new Error(`${where}: "runtimeArgs" deve ser uma lista de textos.`)
    }
    if (
      c.port !== undefined &&
      (typeof c.port !== 'number' || !Number.isInteger(c.port) || c.port <= 0 || c.port > 65535)
    ) {
      throw new Error(`${where}: "port" deve ser um número de porta válido.`)
    }
    if (c.url !== undefined && typeof c.url !== 'string') throw new Error(`${where}: "url" deve ser texto.`)
    return {
      name: c.name,
      runtimeExecutable: c.runtimeExecutable,
      runtimeArgs: c.runtimeArgs as string[] | undefined,
      port: c.port,
      url: c.url
    }
  })
}

export function readLaunchConfigs(sessionId: string): LaunchConfigsResult {
  const path = launchPath(sessionDir(sessionId))
  if (!existsSync(path)) return { path, exists: false, configurations: [] }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { path, exists: true, configurations: [], error: (err as Error).message }
  }
  try {
    return { path, exists: true, text, configurations: parseLaunch(text) }
  } catch (err) {
    return { path, exists: true, text, configurations: [], error: (err as Error).message }
  }
}

export function saveLaunchConfigs(sessionId: string, text: string, overwrite: boolean): LaunchSaveResult {
  try {
    parseLaunch(text)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const path = launchPath(sessionDir(sessionId))
  if (existsSync(path) && !overwrite) return { ok: false, exists: true, error: 'O arquivo já existe.' }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---- processes ----

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

function emitState(run: Running, ready?: boolean): void {
  broadcast(PREVIEW.serverEvent, { type: 'state', server: { ...run.info }, ready } satisfies ServerEvent)
}

function appendLog(run: Running, chunk: string): void {
  run.log.push(chunk)
  run.logChars += chunk.length
  while (run.logChars > MAX_LOG_CHARS && run.log.length > 1) run.logChars -= run.log.shift()!.length
  // Batch log events so a chatty server does not flood IPC.
  run.pending += chunk
  run.flushTimer ??= setTimeout(() => flushLog(run), 60)
}

function flushLog(run: Running): void {
  clearTimeout(run.flushTimer)
  run.flushTimer = undefined
  if (!run.pending) return
  const chunk = run.pending
  run.pending = ''
  broadcast(PREVIEW.serverEvent, {
    type: 'log',
    serverId: run.info.id,
    sessionId: run.info.sessionId,
    chunk
  } satisfies ServerEvent)
}

function portAnswers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function isPortOpen(port: number): Promise<boolean> {
  return (await portAnswers(port, '127.0.0.1')) || (await portAnswers(port, '::1'))
}

function portOf(config: LaunchConfiguration): number | undefined {
  if (config.port) return config.port
  if (!config.url) return undefined
  try {
    const u = new URL(config.url)
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return undefined
  }
}

function waitForPort(run: Running, port: number): void {
  const tick = async () => {
    run.pollTimer = undefined
    if (run.info.status !== 'starting') return
    if (await isPortOpen(port)) {
      if (run.info.status !== 'starting') return
      run.info.status = 'running'
      appendLog(run, `\n[Hangar] Porta ${port} respondendo — abrindo ${run.info.url}\n`)
      emitState(run, true)
      return
    }
    run.pollTimer = setTimeout(() => void tick(), POLL_MS)
  }
  run.pollTimer = setTimeout(() => void tick(), POLL_MS)
}

function killTree(pid: number, sync = false): void {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F']
    if (sync) spawnSync('taskkill', args, { windowsHide: true })
    else execFile('taskkill', args, { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

export function listServers(sessionId?: string): ServerInfo[] {
  return [...servers.values()].filter((r) => !sessionId || r.info.sessionId === sessionId).map((r) => ({ ...r.info }))
}

/** Full log snapshot. Pending log events go out first, so the caller can drop events received before the reply. */
export function serverLogs(serverId: string): string {
  const run = servers.get(serverId)
  if (!run) return ''
  flushLog(run)
  return run.log.join('')
}

export function startServer(sessionId: string, name: string): ServerInfo {
  for (const run of servers.values()) {
    if (
      run.info.sessionId === sessionId &&
      run.info.name === name &&
      (run.info.status === 'starting' || run.info.status === 'running')
    ) {
      return { ...run.info }
    }
  }
  // Forget finished runs of the same configuration so the list stays short.
  for (const [id, run] of servers) {
    if (run.info.sessionId === sessionId && run.info.name === name) servers.delete(id)
  }

  const { configurations, error } = readLaunchConfigs(sessionId)
  if (error) throw new Error(error)
  const config = configurations.find((c) => c.name === name)
  if (!config) throw new Error(`Configuração "${name}" não encontrada em launch.json.`)

  const cwd = sessionDir(sessionId)
  const args = config.runtimeArgs ?? []
  const command = [config.runtimeExecutable, ...args].map(quoteArg).join(' ')
  const port = portOf(config)
  const url = config.url ?? (config.port ? `http://localhost:${config.port}` : undefined)
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: 'none' }
  if (config.port && !env.PORT) env.PORT = String(config.port)

  // On Windows, npm/npx/pnpm are .cmd shims that only run through a shell.
  const child =
    process.platform === 'win32'
      ? spawn(command, { cwd, env, shell: true, windowsHide: true })
      : spawn(config.runtimeExecutable, args, { cwd, env, detached: true })

  const run: Running = {
    info: {
      id: randomUUID(),
      sessionId,
      name,
      cwd,
      command,
      port,
      url,
      status: 'starting',
      pid: child.pid,
      startedAt: Date.now()
    },
    child,
    log: [],
    logChars: 0,
    pending: '',
    stopRequested: false
  }
  servers.set(run.info.id, run)
  appendLog(run, `> ${command}\n  (em ${cwd})\n\n`)

  child.stdout?.setEncoding('utf8').on('data', (d: string) => appendLog(run, d))
  child.stderr?.setEncoding('utf8').on('data', (d: string) => appendLog(run, d))
  child.once('error', (err) => {
    clearTimeout(run.pollTimer)
    run.info.status = 'error'
    run.info.error = err.message
    appendLog(run, `\n[Hangar] Falha ao iniciar: ${err.message}\n`)
    emitState(run)
  })
  child.once('exit', (code) => {
    clearTimeout(run.pollTimer)
    if (run.info.status === 'error') return
    run.info.status = 'exited'
    run.info.exitCode = code
    appendLog(run, `\n[Hangar] Processo encerrado${code === null ? '' : ` (código ${code})`}.\n`)
    emitState(run)
  })

  if (port) {
    waitForPort(run, port)
  } else {
    run.info.status = 'running'
  }
  emitState(run)
  return { ...run.info }
}

export function stopServer(serverId: string): void {
  const run = servers.get(serverId)
  if (!run) return
  if (run.info.status === 'exited' || run.info.status === 'error') {
    servers.delete(serverId)
    broadcast(PREVIEW.serverEvent, { type: 'state', server: { ...run.info } } satisfies ServerEvent)
    return
  }
  run.stopRequested = true
  run.info.status = 'stopping'
  clearTimeout(run.pollTimer)
  emitState(run)
  if (run.child.pid) killTree(run.child.pid)
  else run.child.kill()
}

/** Stops every server of a session (e.g. when the session is deleted). */
export function stopSessionServers(sessionId: string): void {
  for (const run of servers.values()) if (run.info.sessionId === sessionId) stopServer(run.info.id)
}

/** Synchronously kills every child process. Called on app quit. */
export function disposeServers(): void {
  for (const run of servers.values()) {
    clearTimeout(run.pollTimer)
    clearTimeout(run.flushTimer)
    if (run.child.exitCode === null && run.child.pid) killTree(run.child.pid, true)
  }
  servers.clear()
}
