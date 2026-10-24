// Agent SDK plumbing: lazy loading (the SDK is ESM-only), executable discovery, environment
// and the async input queue that keeps a query in streaming-input mode.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { settings } from '../../core/store'
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

/** Subprocess environment without ANTHROPIC_API_KEY, so the CLI uses the subscription login. */
export function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'hangar/0.1.0' }
  delete env.ANTHROPIC_API_KEY
  return env
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
export function probeCommands(cwd: string): Promise<SlashCommandInfo[]> {
  let p = probes.get(cwd)
  if (!p) {
    p = (async () => {
      const sdk = await loadSdk()
      const input = new MessageQueue()
      const q = sdk.query({
        prompt: input,
        options: { cwd, pathToClaudeCodeExecutable: resolveClaudeExecutable(), env: claudeEnv(), persistSession: false }
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
    p.catch(() => probes.delete(cwd))
    probes.set(cwd, p)
  }
  return p
}
