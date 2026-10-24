// Agent SDK plumbing: lazy loading (the SDK is ESM-only), executable discovery, environment
// and the async input queue that keeps a query in streaming-input mode.
//
// Launching Claude Code from another feature: spread `claudeLaunchOptions(providerId?)` into the query options.
// It applies the session's (or the default) provider profile: executable, environment and the flag-settings
// `env` that must outrank the user's ~/.claude/settings.json. `claudeEnv()` alone misses that override and is
// kept only for existing callers.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import type { SDKUserMessage, Settings as SdkSettings } from '@anthropic-ai/claude-agent-sdk'
import { settings } from '../../core/store'
import { resolveProviderLaunch } from '../settings/providers-api'
import type { SlashCommandInfo } from '../../../shared/features/engine'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule> | undefined

export function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

/**
 * The user's own `claude` binary, so the session inherits the subscription login of the CLI.
 * Falls back to the SDK's bundled binary (undefined), which reads the same ~/.claude credentials.
 */
export function resolveClaudeExecutable(): string | undefined {
  const configured = settings().get().claudeExecutablePath
  if (configured && existsSync(configured)) return configured
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir.replace(/^"|"$/g, ''), name)
    if (existsSync(candidate)) return candidate
  }
  // Apps launched from the Start menu may not see the user's PATH additions.
  const native = join(homedir(), '.local', 'bin', name)
  if (existsSync(native)) return native
  // Packaged app: the SDK would resolve its bundled binary inside app.asar, which cannot be spawned.
  try {
    const bundled = createRequire(__filename)
      .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${name}`)
      .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    if (existsSync(bundled)) return bundled
  } catch {
    // Platform package not installed: let the SDK report it.
  }
  return undefined
}

/** The parts of the query options that decide how Claude Code reaches a model. */
export interface ClaudeLaunchOptions {
  pathToClaudeCodeExecutable?: string
  env: Record<string, string | undefined>
  /** Flag settings: the profile's variables, so they win over ~/.claude/settings.json. */
  settings?: SdkSettings
}

export interface ClaudeLaunch {
  options: ClaudeLaunchOptions
  /** Profile's model for sessions without an explicit one. */
  defaultModel?: string
  /** Secret values of this launch, to mask in anything shown to the user. */
  secrets: string[]
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/**
 * Resolves a provider profile (undefined → settings().defaultProviderId → subscription) into launch options:
 * env = process.env − launch.unset + launch.env (+ our client id), settings.env = launch.settingsEnv when not empty.
 * Throws when the profile cannot be resolved (the caller reports it).
 */
export function claudeLaunch(providerId?: string): ClaudeLaunch {
  const launch = resolveProviderLaunch(providerId)
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of launch.unset) delete env[name]
  Object.assign(env, launch.env, { CLAUDE_AGENT_SDK_CLIENT_APP: 'hangar/0.1.0' })
  const options: ClaudeLaunchOptions = { pathToClaudeCodeExecutable: resolveClaudeExecutable(), env }
  if (Object.keys(launch.settingsEnv).length) options.settings = { env: { ...launch.settingsEnv } }
  const secrets = [launch.env, launch.settingsEnv].flatMap((vars) =>
    Object.entries(vars)
      .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= 6)
      .map(([, value]) => value)
  )
  return { options, defaultModel: launch.defaultModel, secrets }
}

/** Executable, environment and flag settings for a Claude Code launch under a provider profile. */
export function claudeLaunchOptions(providerId?: string): ClaudeLaunchOptions {
  return claudeLaunch(providerId).options
}

/**
 * Subprocess environment for a provider profile (default: the configured default profile; the subscription
 * profile removes ANTHROPIC_API_KEY so the CLI uses the subscription login). Prefer `claudeLaunchOptions`.
 */
export function claudeEnv(providerId?: string): Record<string, string | undefined> {
  return claudeLaunch(providerId).options.env
}

/** Push-based AsyncIterable of user messages; stays open until close(). */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: message, done: false })
    } else {
      this.items.push(message)
    }
  }

  close(): void {
    this.closed = true
    const w = this.waiter
    this.waiter = undefined
    w?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      }
    }
  }
}

export function toCommandInfo(c: { name: string; description: string; argumentHint?: string }): SlashCommandInfo {
  return { name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }
}

const probes = new Map<string, Promise<SlashCommandInfo[]>>()

/**
 * Slash commands for a folder before any conversation exists there: starts a throwaway CLI
 * process, reads its initialize response and closes it. Cached per cwd.
 */
export function probeCommands(cwd: string, providerId?: string): Promise<SlashCommandInfo[]> {
  const key = `${providerId ?? ''}\u0000${cwd}`
  let p = probes.get(key)
  if (!p) {
    p = (async () => {
      const sdk = await loadSdk()
      const input = new MessageQueue()
      const q = sdk.query({
        prompt: input,
        options: { cwd, ...claudeLaunchOptions(providerId), persistSession: false }
      })
      try {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000))
        const commands = await Promise.race([q.supportedCommands(), timeout])
        return commands.map(toCommandInfo)
      } finally {
        input.close()
        q.close()
      }
    })()
    p.catch(() => probes.delete(key))
    probes.set(key, p)
  }
  return p
}
