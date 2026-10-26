// IPC channels and payload types for the "bench" feature (model bench): runs a fixed suite of coding tasks against
// provider models, with Hangar's compat layer ("hangar") and without it ("baseline"), and scores the deliveries.
export const BENCH = {
  /** () → BenchTaskInfo[] */
  tasks: 'bench:tasks',
  /** (providerId) → string[] — model ids the gateway lists (GET /v1/models with the profile's key). */
  models: 'bench:models',
  /** (request: BenchRequest) → string (run id); progress arrives as evProgress. */
  run: 'bench:run',
  /** (runId) → void — stops after the current task. */
  stop: 'bench:stop',
  /** () → BenchRunSummary[] — newest first. */
  list: 'bench:list',
  /** (runId) → BenchRun | undefined */
  get: 'bench:get',

  /** main → renderer: the run after each task. */
  evProgress: 'bench:event:progress'
} as const

/** "hangar": the compat layer on (as sessions run). "baseline": Claude Code's requests and options unchanged. */
export type BenchVariant = 'hangar' | 'baseline'

export interface BenchTaskInfo {
  id: string
  title: string
  /** What the task exercises (pt-BR). */
  skills: string
}

export interface BenchPrice {
  /** USD per million input tokens (cache reads are counted at this price too: an upper bound). */
  input: number
  /** USD per million output tokens. */
  output: number
}

export interface BenchRequest {
  providerId: string
  models: string[]
  variants: BenchVariant[]
  /** Default: every task. */
  taskIds?: string[]
  /** Runs per task × model × variant (default 1). */
  repeats?: number
  /** The run stops scheduling tasks once the estimated cost reaches this (default 5). */
  maxCostUsd?: number
  /** Per task (default 30). */
  maxTurns?: number
  /** Prices by model id, for the cost estimate (models not listed use the built-in table, then a high default). */
  prices?: Record<string, BenchPrice>
}

export interface BenchCompatCounters {
  adaptedRequests: number
  retries: number
  upstreamErrors: Record<string, number>
  repairs: { name: number; args: number; json: number; nulls: number; types: number }
  textToolCalls: number
  maxTokensStops: number
}

export interface BenchResult {
  taskId: string
  model: string
  variant: BenchVariant
  repeat: number
  /** The check passed. */
  ok: boolean
  /** Why the check failed, or the error that ended the task (pt-BR or the provider's text). */
  reason?: string
  /** The run ended on a provider/API error rather than a wrong delivery. */
  apiError?: boolean
  durationMs: number
  turns: number
  toolCalls: number
  /** tool_result blocks marked as errors. */
  toolErrors: number
  /** Tool calls Claude Code rejected for their arguments (InputValidationError). */
  invalidToolCalls: number
  /** The first tool errors, "Tool: message" (cut short), to see what went wrong without a transcript. */
  toolErrorSamples?: string[]
  apiRetries: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  /** Counters of the compat proxy for this task ("hangar" variant only). */
  compat?: BenchCompatCounters
}

export interface BenchScore {
  model: string
  variant: BenchVariant
  runs: number
  passed: number
  /** passed / runs (0..1). */
  successRate: number
  avgTurns: number
  avgToolCalls: number
  /** Tool errors per tool call. */
  toolErrorRate: number
  invalidToolCalls: number
  apiErrors: number
  avgDurationMs: number
  tokens: number
  costUsd: number
  repairs: number
}

export type BenchStatus = 'running' | 'done' | 'stopped' | 'failed'

export interface BenchRunSummary {
  id: string
  providerId: string
  providerName: string
  startedAt: number
  finishedAt?: number
  status: BenchStatus
  /** Tasks planned / finished. */
  planned: number
  finished: number
  costUsd: number
  scores: BenchScore[]
  error?: string
}

export interface BenchRun extends BenchRunSummary {
  request: BenchRequest
  results: BenchResult[]
}

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [BENCH.tasks]: () => BenchTaskInfo[]
    [BENCH.models]: (providerId: string) => string[]
    [BENCH.run]: (request: BenchRequest) => string
    [BENCH.stop]: (runId: string) => void
    [BENCH.list]: () => BenchRunSummary[]
    [BENCH.get]: (runId: string) => BenchRun | undefined
  }

  interface IpcEventContract {
    [BENCH.evProgress]: BenchRunSummary
  }
}
