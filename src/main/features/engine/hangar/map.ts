// Pure translations between the app's vocabulary (Claude Code's tool names, permission modes, effort) and the
// Hangar Harness bridge protocol. No Electron imports: unit-tested in tests/unit/hangar-engine.test.ts.
import { isAbsolute, resolve } from 'node:path'
import type { Effort, PermissionMode } from '../../../../shared/contracts'
import type { ProviderModels } from '../../../../shared/providers'

export type HangarPermission = 'auto' | 'ask' | 'edits' | 'readonly'

/** The app's permission modes on the harness: it has no notion of "bypass", only of what still needs asking. */
export function permissionFor(mode: PermissionMode | undefined): HangarPermission {
  switch (mode) {
    case 'acceptEdits':
      return 'edits'
    case 'plan':
      return 'readonly'
    case 'auto':
    case 'bypassPermissions':
      return 'auto'
    default:
      return 'ask'
  }
}

export function effortFor(effort: Effort | undefined): 'low' | 'medium' | 'high' {
  if (effort === 'low' || effort === 'medium') return effort
  return 'high'
}

/**
 * Gateway profiles store the Anthropic-style base URL (no /v1). The harness speaks the OpenAI chat API, which the
 * same gateways serve under /v1 (LiteLLM: http://host:4000/v1, OpenRouter: https://openrouter.ai/api/v1).
 */
export function openAiBaseUrl(base: string): string {
  const url = base.trim().replace(/\/+$/, '')
  return /\/v\d+$/.test(url) ? url : `${url}/v1`
}

/** A session's model may be one of the profile's aliases (opus, sonnet, haiku) or empty (the profile's default). */
export function resolveModel(model: string | undefined, models: ProviderModels | undefined): string | undefined {
  const m = model?.trim()
  if (!m) return models?.default?.trim() || undefined
  if (m === 'opus' || m === 'sonnet' || m === 'haiku')
    return models?.[m]?.trim() || models?.default?.trim() || undefined
  return m
}

export interface MappedTool {
  name: string
  input: Record<string, unknown>
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function abs(cwd: string, p: unknown): string | undefined {
  const s = str(p)?.trim()
  if (!s) return undefined
  return isAbsolute(s) ? s : resolve(cwd, s)
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k]
  return input
}

const TODO_STATUS: Record<string, 'pending' | 'in_progress' | 'completed'> = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
  completed: 'completed'
}

/**
 * A harness tool call as the Claude Code tool the interface already knows how to draw (diff cards for edits, the
 * pinned checklist for plans, shell output for commands). Unknown tools pass through with their own name.
 */
export function mapTool(name: string, args: Record<string, unknown>, cwd: string): MappedTool {
  switch (name) {
    case 'read':
      return {
        name: 'Read',
        input: compact({ file_path: abs(cwd, args.path), offset: args.offset, limit: args.limit })
      }
    case 'write':
      return { name: 'Write', input: compact({ file_path: abs(cwd, args.path), content: str(args.content) ?? '' }) }
    case 'edit':
      return {
        name: 'Edit',
        input: compact({
          file_path: abs(cwd, args.path),
          old_string: str(args.old) ?? '',
          new_string: str(args.new) ?? '',
          replace_all: args.all === true ? true : undefined
        })
      }
    case 'glob':
      return { name: 'Glob', input: compact({ pattern: args.pattern, path: args.path }) }
    case 'grep':
      return { name: 'Grep', input: compact({ pattern: args.pattern, path: args.path, glob: args.glob }) }
    case 'shell':
      return {
        name: 'Bash',
        input: compact({
          command: str(args.command) ?? '',
          timeout: args.timeout,
          run_in_background: args.background === true ? true : undefined
        })
      }
    case 'web_fetch':
      return { name: 'WebFetch', input: compact({ url: args.url }) }
    case 'web_search':
      return { name: 'WebSearch', input: compact({ query: args.query }) }
    case 'plan': {
      const items = Array.isArray(args.items) ? args.items : []
      const todos = items.map((it) => {
        const o = (it && typeof it === 'object' ? it : { step: String(it) }) as Record<string, unknown>
        const content = str(o.step) ?? str(o.content) ?? ''
        return { content, status: TODO_STATUS[str(o.status) ?? 'pending'] ?? 'pending', activeForm: content }
      })
      return { name: 'TodoWrite', input: { todos } }
    }
    case 'task': {
      const prompt = str(args.prompt) ?? ''
      return { name: 'Agent', input: { description: prompt.trim().split('\n')[0].slice(0, 120), prompt } }
    }
    case 'ask_user': {
      const options = Array.isArray(args.options) ? args.options.map((o) => ({ label: String(o) })) : []
      return { name: 'AskUserQuestion', input: { questions: [{ question: str(args.question) ?? '', options }] } }
    }
    case 'skill':
      return { name: 'Skill', input: compact({ skill: args.name }) }
    case 'mcp_call':
      return {
        name: `mcp__${str(args.name) ?? 'tool'}`,
        input: (args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) as Record<string, unknown>
      }
    default:
      return { name, input: args }
  }
}

/** Claude's usage counts cached tokens apart from input tokens; the harness reports them inside the prompt total. */
export function freshInputTokens(prompt: number, cached: number, cacheWrite: number): number {
  return Math.max(0, Math.round(prompt) - Math.round(cached) - Math.round(cacheWrite))
}

/** Provider-side failures by the harness's error kind (the rest are task errors). */
export function isProviderErrorKind(kind: string | undefined): boolean {
  return kind === 'auth' || kind === 'credits' || kind === 'network' || kind === 'transient'
}
