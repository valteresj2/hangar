// A one-shot query on the Hangar engine, without a session or a transcript: what the Lab's proposer and selector,
// the lessons reflector and the model bench use when the provider profile runs on the Hangar Harness.
// The counterpart of calling the Agent SDK's query() directly for Claude Code.
import { resolveProviderLaunch } from '../../settings/providers-api'
import type { SessionEngine } from '../../../../shared/providers'
import { effectiveProviderId, profiles } from '../providers'
import { HangarBridge, type BridgeEvent } from './bridge'
import { mapTool, openAiBaseUrl, resolveModel, type HangarPermission, type MappedTool } from './map'

export interface HeadlessOptions {
  cwd: string
  prompt: string
  /** Provider profile; default: the app's default profile. */
  providerId?: string
  /** Model id or a profile alias; default: the profile's default model. */
  model?: string
  /** Default 'auto' (nothing asks). With 'ask' or 'edits', `onPermission` decides each request. */
  permission?: HangarPermission
  /** Harness tool names this query may use ([] = none: a pure text answer). Default: the harness's full catalog. */
  allowedTools?: string[]
  /** File tools may not leave `cwd` (the Lab's proposer works on an evidence folder only). */
  confine?: boolean
  /** Extra system instructions. */
  system?: string
  maxSteps?: number
  effort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
  timeoutMs?: number
  /** Decides a permission request; `tool` is the Claude Code equivalent (Write, Edit, Bash…). Default: deny. */
  onPermission?(tool: MappedTool): { allow: boolean; message?: string }
  onEvent?(ev: BridgeEvent): void
}

export interface HeadlessResult {
  /** The model's final answer. */
  text: string
  /** success | incomplete | interrupted | error */
  status: string
  error?: string
  /** The harness's error kind when the provider failed (auth, credits, network, transient). */
  errorKind?: string
  costUsd: number
  steps: number
  toolCalls: number
  toolErrors: number
  /** Up to 6 "<tool>: <message>" samples of failed tool calls. */
  toolErrorSamples: string[]
  /** Tool calls the harness had to reject for their shape (unknown tool, missing or malformed arguments). */
  invalidToolCalls: number
  /** Prompt tokens not read from cache. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  model?: string
  /** Secrets of the launch, to mask in anything shown to the user. */
  secrets: string[]
}

const INVALID_CALL =
  /unknown tool|Missing required argument|not valid JSON|Arguments must be a JSON object|could not be parsed/i

/** The engine of a provider profile (default: the app's default profile). */
export function engineOfProfile(providerId?: string): SessionEngine {
  const id = providerId || effectiveProviderId()
  return profiles().find((p) => p.id === id)?.engine === 'hangar' ? 'hangar' : 'claude'
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function hangarQuery(o: HeadlessOptions): Promise<HeadlessResult> {
  const launch = resolveProviderLaunch(o.providerId)
  const base = launch.env.ANTHROPIC_BASE_URL
  if (!base)
    throw new Error('Este perfil não tem URL base: o motor Hangar precisa de um gateway compatível com OpenAI.')
  const apiKey = launch.env.ANTHROPIC_AUTH_TOKEN || launch.env.ANTHROPIC_API_KEY || undefined
  const model = resolveModel(o.model, launch.models)
  if (!model) throw new Error('Defina o modelo padrão do perfil: o motor Hangar não tem um modelo implícito.')

  const result: HeadlessResult = {
    text: '',
    status: 'error',
    costUsd: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolErrorSamples: [],
    invalidToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    secrets: apiKey && apiKey.length >= 6 ? [apiKey] : []
  }
  const names = new Map<string, string>()

  return new Promise<HeadlessResult>((resolve) => {
    let done = false
    let aborted = false
    const finish = (patch: Partial<HeadlessResult> = {}) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      Object.assign(result, patch)
      bridge.close()
      resolve(result)
    }
    const onAbort = () => {
      aborted = true
      bridge.send({ type: 'interrupt' })
      // The harness answers an interrupt with turn_end; if it is stuck, do not wait for it.
      setTimeout(() => finish({ status: 'interrupted', error: 'Interrompida.' }), 4000).unref()
    }
    const timer = setTimeout(
      () => {
        aborted = true
        bridge.send({ type: 'interrupt' })
        setTimeout(() => finish({ status: 'interrupted', error: 'Tempo esgotado.' }), 4000).unref()
      },
      o.timeoutMs ?? 30 * 60_000
    )

    const handle = (ev: BridgeEvent): void => {
      o.onEvent?.(ev)
      const agent = typeof ev.agent === 'string' ? ev.agent : 'work'
      const main = agent === 'work' || agent === 'main'
      switch (ev.type) {
        case 'ready':
          bridge.send({ type: 'user', text: o.prompt })
          return
        case 'fatal':
          return finish({ status: 'error', error: str(ev.message) })
        case 'assistant':
          if (main && str(ev.text).trim()) result.text = str(ev.text)
          return
        case 'tool_start':
          if (!main) return
          result.toolCalls++
          names.set(str(ev.id), str(ev.name))
          return
        case 'tool_end': {
          if (!main || ev.ok !== false) return
          result.toolErrors++
          const message = (str(ev.output) || str(ev.preview)).replace(/\s+/g, ' ').slice(0, 200)
          if (result.toolErrorSamples.length < 6)
            result.toolErrorSamples.push(`${names.get(str(ev.id)) ?? str(ev.name) ?? '?'}: ${message}`)
          if (INVALID_CALL.test(message)) result.invalidToolCalls++
          return
        }
        case 'permission': {
          const decision = o.onPermission?.(mapTool(str(ev.tool), obj(ev.args), o.cwd)) ?? {
            allow: false,
            message: 'Not allowed in this run.'
          }
          bridge.send({
            type: 'permission_response',
            qid: str(ev.qid),
            decision: decision.allow ? 'allow' : 'deny',
            ...(decision.message ? { message: decision.message } : {})
          })
          return
        }
        case 'question':
          if (ev.kind === 'approval') return
          bridge.send({
            type: 'answer',
            qid: str(ev.qid),
            answer: 'Nobody is available to answer: decide on your own.'
          })
          return
        case 'turn_end': {
          const status = aborted ? 'interrupted' : str(ev.status) || 'error'
          const cached = num(ev.cached)
          return finish({
            status,
            ...(status !== 'success' && str(ev.error) ? { error: str(ev.error) } : {}),
            ...(str(ev.error_kind) ? { errorKind: str(ev.error_kind) } : {}),
            costUsd: num(ev.session_cost),
            steps: num(ev.steps),
            inputTokens: Math.max(0, num(ev.prompt) - cached),
            outputTokens: num(ev.completion),
            cacheReadTokens: cached,
            ...(str(ev.model) ? { model: str(ev.model) } : {})
          })
        }
        default:
          return
      }
    }

    const bridge: HangarBridge = new HangarBridge({
      apiKey,
      start: {
        cwd: o.cwd,
        model,
        base_url: openAiBaseUrl(base),
        permission: o.permission ?? 'auto',
        ...(o.effort ? { effort: o.effort } : {}),
        ...(o.system ? { system_append: o.system } : {}),
        ...(o.allowedTools ? { allowed_tools: o.allowedTools } : {}),
        ...(o.maxSteps ? { max_steps: o.maxSteps } : {}),
        ...(o.confine ? { confine: true } : {}),
        ...(launch.compat?.contextWindow ? { context_window: launch.compat.contextWindow } : {}),
        title: '(headless)'
      },
      onEvent: handle,
      onExit: (code, stderr) =>
        finish({ status: 'error', error: stderr || `O motor Hangar encerrou (código ${code ?? '?'}).` })
    })
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort)
  })
}
