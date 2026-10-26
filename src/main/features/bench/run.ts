// Runs the model bench: every task × model × variant × repeat, one at a time, each in a fresh temp folder.
//
// "hangar" launches exactly like a session (compat proxy route of its own, compatSession options); "baseline"
// launches like Hangar did before the compat layer (direct to the gateway, adaptive thinking, effort, Claude Code's
// full toolset). Metrics come from the SDK messages and, for "hangar", from the proxy route's counters.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  BENCH,
  type BenchPrice,
  type BenchRequest,
  type BenchResult,
  type BenchRun,
  type BenchRunSummary,
  type BenchScore,
  type BenchVariant
} from '../../../shared/features/bench'
import { broadcast } from '../../core/broadcast'
import { settings } from '../../core/store'
import { compatSession, releaseRoute, routeStats } from '../engine/compat'
import { claudeLaunch, loadSdk, withEnv } from '../engine/sdk'
import { resolveProviderLaunch } from '../settings/providers-api'
import { maskSecrets, providerInfo } from '../engine/providers'
import { seeded, TASKS, type BenchTask } from './tasks'
import { saveRun } from './store'

const TASK_TIMEOUT_MS = 6 * 60_000

// USD per million tokens (input, output), list prices 2026. Cache reads are billed as input here: an upper bound.
const PRICES: [RegExp, BenchPrice][] = [
  [/gpt-5-nano/, { input: 0.05, output: 0.4 }],
  [/gpt-5-mini/, { input: 0.25, output: 2 }],
  [/gpt-5/, { input: 1.25, output: 10 }],
  [/gpt-4\.1-nano/, { input: 0.1, output: 0.4 }],
  [/gpt-4\.1-mini/, { input: 0.4, output: 1.6 }],
  [/gpt-4\.1/, { input: 2, output: 8 }],
  [/gpt-4o-mini/, { input: 0.15, output: 0.6 }],
  [/gpt-4o/, { input: 2.5, output: 10 }],
  [/gpt-oss/, { input: 0.1, output: 0.5 }],
  [/o4-mini|o3-mini/, { input: 1.1, output: 4.4 }],
  [/deepseek/, { input: 0.3, output: 1.2 }],
  [/qwen/, { input: 0.3, output: 1.2 }],
  [/llama/, { input: 0.2, output: 0.6 }],
  [/gemini.*flash/, { input: 0.3, output: 2.5 }],
  [/gemini/, { input: 1.25, output: 10 }],
  [/haiku/, { input: 1, output: 5 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/opus/, { input: 5, output: 25 }]
]
/** Unknown models: assume an expensive one so the budget guard errs on the safe side. */
const DEFAULT_PRICE: BenchPrice = { input: 3, output: 15 }

export function priceFor(model: string, prices?: Record<string, BenchPrice>): BenchPrice {
  if (prices?.[model]) return prices[model]
  const id = model.toLowerCase()
  return PRICES.find(([re]) => re.test(id))?.[1] ?? DEFAULT_PRICE
}

const active = new Map<string, { stop: boolean; abort?: AbortController }>()

export function stopRun(id: string): void {
  const r = active.get(id)
  if (!r) return
  r.stop = true
  r.abort?.abort()
}

export function scoreResults(results: BenchResult[]): BenchScore[] {
  const groups = new Map<string, BenchResult[]>()
  for (const r of results) {
    const key = `${r.model}\u0000${r.variant}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.values()].map((rs) => {
    const sum = (f: (r: BenchResult) => number) => rs.reduce((t, r) => t + f(r), 0)
    const calls = sum((r) => r.toolCalls)
    const passed = rs.filter((r) => r.ok).length
    return {
      model: rs[0].model,
      variant: rs[0].variant,
      runs: rs.length,
      passed,
      successRate: passed / rs.length,
      avgTurns: sum((r) => r.turns) / rs.length,
      avgToolCalls: calls / rs.length,
      toolErrorRate: calls ? sum((r) => r.toolErrors) / calls : 0,
      invalidToolCalls: sum((r) => r.invalidToolCalls),
      apiErrors: rs.filter((r) => r.apiError).length,
      avgDurationMs: sum((r) => r.durationMs) / rs.length,
      tokens: sum((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens),
      costUsd: sum((r) => r.costUsd),
      repairs: sum((r) => (r.compat ? Object.values(r.compat.repairs).reduce((a, b) => a + b, 0) : 0))
    }
  })
}

export function summarize(run: BenchRun): BenchRunSummary {
  const { request: _request, results: _results, ...summary } = run
  return summary
}

/** Starts a run in the background; returns its id. */
export function startRun(request: BenchRequest): string {
  const models = [...new Set(request.models.map((m) => m.trim()).filter(Boolean))]
  if (!models.length) throw new Error('Escolha pelo menos um modelo.')
  const variants = request.variants.length ? [...new Set(request.variants)] : (['hangar'] as BenchVariant[])
  const tasks = request.taskIds?.length ? TASKS.filter((t) => request.taskIds!.includes(t.id)) : TASKS
  if (!tasks.length) throw new Error('Nenhuma tarefa encontrada.')
  // Fails early (and in the caller) when the profile cannot be resolved, e.g. no key saved.
  claudeLaunch(request.providerId)
  const repeats = Math.max(1, Math.min(5, Math.round(request.repeats ?? 1)))

  const id = `bench_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`
  const run: BenchRun = {
    id,
    providerId: request.providerId,
    providerName: providerInfo(request.providerId).name,
    startedAt: Date.now(),
    status: 'running',
    planned: tasks.length * models.length * variants.length * repeats,
    finished: 0,
    costUsd: 0,
    scores: [],
    request: { ...request, models, variants },
    results: []
  }
  active.set(id, { stop: false })
  const publish = () => {
    run.scores = scoreResults(run.results)
    run.costUsd = run.results.reduce((t, r) => t + r.costUsd, 0)
    saveRun(run)
    broadcast(BENCH.evProgress, summarize(run))
  }
  publish()

  void (async () => {
    const budget = request.maxCostUsd ?? 5
    try {
      // Interleaved so a stopped or over-budget run still compares every model and variant on the same tasks.
      outer: for (let repeat = 0; repeat < repeats; repeat++) {
        for (const task of tasks) {
          for (const model of models) {
            for (const variant of variants) {
              const state = active.get(id)!
              if (state.stop) {
                run.status = 'stopped'
                break outer
              }
              if (run.costUsd >= budget) {
                run.status = 'stopped'
                run.error = `Orçamento de US$ ${budget.toFixed(2)} atingido (estimativa).`
                break outer
              }
              run.results.push(await runTask(task, model, variant, repeat, request, state))
              run.finished++
              publish()
            }
          }
        }
      }
      if (run.status === 'running') run.status = 'done'
    } catch (err) {
      run.status = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
    } finally {
      run.finishedAt = Date.now()
      active.delete(id)
      publish()
    }
  })()
  return id
}

interface ToolResultBlock {
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

function toolResults(msg: SDKMessage): ToolResultBlock[] {
  if (msg.type !== 'user' || !Array.isArray(msg.message.content)) return []
  return msg.message.content.filter((b) => (b as { type?: string }).type === 'tool_result') as ToolResultBlock[]
}

async function runTask(
  task: BenchTask,
  model: string,
  variant: BenchVariant,
  repeat: number,
  request: BenchRequest,
  state: { stop: boolean; abort?: AbortController }
): Promise<BenchResult> {
  const dir = mkdtempSync(join(tmpdir(), `hangar-bench-${task.id}-`))
  const started = Date.now()
  const result: BenchResult = {
    taskId: task.id,
    model,
    variant,
    repeat,
    ok: false,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    invalidToolCalls: 0,
    apiRetries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0
  }
  const launch = claudeLaunch(request.providerId, { ownCompatRoute: true, noCompat: variant === 'baseline' })
  const abort = new AbortController()
  state.abort = abort
  const timer = setTimeout(() => abort.abort(), TASK_TIMEOUT_MS)
  let apiError: string | undefined
  const toolNames = new Map<string, string>()
  try {
    const ctx = task.setup(dir, seeded(hash(`${task.id}:${repeat}`)))
    const compat = variant === 'hangar' ? compatSession(launch.profile, model) : undefined
    const options = withEnv(launch.options, compat?.env ?? {})
    const defaults = settings().get()
    const sdk = await loadSdk()
    const q = sdk.query({
      prompt: task.prompt(ctx),
      options: {
        cwd: dir,
        model,
        ...options,
        ...(compat?.dropEffort ? {} : { effort: defaults.defaultEffort }),
        ...(compat?.tools ? { tools: compat.tools } : {}),
        thinking: compat?.thinking ?? { type: 'adaptive', display: 'summarized' },
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(compat?.append ? { append: compat.append } : {}) },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: request.maxTurns ?? 30,
        persistSession: false,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        abortController: abort
      }
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content) {
          if (b.type !== 'tool_use') continue
          result.toolCalls++
          toolNames.set(b.id, b.name)
        }
        if (msg.error) apiError = msg.error
      } else if (msg.type === 'user') {
        for (const r of toolResults(msg)) {
          if (!r.is_error) continue
          result.toolErrors++
          const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')
          if ((result.toolErrorSamples ??= []).length < 6)
            result.toolErrorSamples.push(
              `${toolNames.get(r.tool_use_id ?? '') ?? '?'}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`
            )
          if (
            /InputValidationError|invalid (tool )?(input|parameters)|required parameter|unknown tool|No such tool/i.test(
              text
            )
          )
            result.invalidToolCalls++
        }
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        result.apiRetries++
        apiError = msg.error_status ? `HTTP ${msg.error_status}: ${msg.error}` : msg.error
      } else if (msg.type === 'result') {
        result.turns = msg.num_turns
        result.inputTokens = (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
        result.outputTokens = msg.usage.output_tokens ?? 0
        result.cacheReadTokens = msg.usage.cache_read_input_tokens ?? 0
        if (msg.subtype !== 'success') {
          result.reason =
            msg.subtype === 'error_max_turns' ? 'Limite de turnos atingido.' : msg.errors.join('\n') || msg.subtype
        } else if (msg.is_error) {
          result.reason = msg.result
        }
        break
      }
    }
    q.close()
    const check = task.check(dir, ctx)
    result.ok = check.ok
    if (!check.ok) result.reason = [check.reason, result.reason].filter(Boolean).join(' · ')
  } catch (err) {
    result.reason = abort.signal.aborted
      ? state.stop
        ? 'Interrompido.'
        : `Tempo esgotado (${TASK_TIMEOUT_MS / 60_000} min).`
      : err instanceof Error
        ? err.message
        : String(err)
  } finally {
    clearTimeout(timer)
    state.abort = undefined
    if (launch.compatRoute) {
      const s = routeStats(launch.compatRoute)
      if (s) {
        result.compat = {
          adaptedRequests: s.adaptedRequests,
          retries: s.retries,
          upstreamErrors: s.upstreamErrors,
          repairs: s.repairs,
          textToolCalls: s.textToolCalls,
          maxTokensStops: s.maxTokensStops
        }
      }
      releaseRoute(launch.compatRoute)
    }
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }
  if (!result.ok && apiError && !result.toolCalls) result.apiError = true
  if (!result.ok && apiError) result.reason = [result.reason, `API: ${apiError}`].filter(Boolean).join(' · ')
  if (result.reason) result.reason = maskSecrets(result.reason, launch.secrets).slice(0, 600)
  result.durationMs = Date.now() - started
  const price = priceFor(model, request.prices)
  result.costUsd =
    ((result.inputTokens + result.cacheReadTokens) * price.input + result.outputTokens * price.output) / 1_000_000
  return result
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Model ids a gateway lists (OpenAI-style `data[].id`, as LiteLLM and OpenRouter answer GET /v1/models). */
export async function gatewayModels(providerId: string): Promise<string[]> {
  const { env } = resolveProviderLaunch(providerId)
  const base = env.ANTHROPIC_BASE_URL
  if (!base) throw new Error('Este perfil não é um gateway com URL própria.')
  const headers: Record<string, string> = {}
  if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`
  if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY
  const res = await fetch(`${base.replace(/\/+$/, '')}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`O gateway respondeu HTTP ${res.status} ao listar modelos.`)
  const body = (await res.json()) as { data?: { id?: unknown }[] }
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
}
