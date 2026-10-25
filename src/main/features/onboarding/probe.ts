// A one-turn headless query used to test an endpoint that isn't a saved provider profile
// (the "direct to Anthropic" check). Mirrors the settings feature's connection test.

import { tmpdir } from 'node:os'
import { loadSdk, resolveClaudeExecutable } from '../engine/sdk'
import { maskSecrets } from '../settings/providers'

export interface ProbeResult {
  ok: boolean
  model?: string
  latencyMs: number
  error?: string
}

const TIMEOUT_MS = 90_000

export async function probe(
  env: Record<string, string | undefined>,
  settingsEnv: Record<string, string>,
  model = 'haiku'
): Promise<ProbeResult> {
  const started = Date.now()
  const abort = new AbortController()
  let failure: string | undefined
  let answered: string | undefined
  const timer = setTimeout(() => {
    failure ??= `Tempo esgotado (${TIMEOUT_MS / 1000} s) sem resposta.`
    abort.abort()
  }, TIMEOUT_MS)
  try {
    const sdk = await loadSdk()
    const q = sdk.query({
      prompt: 'Responda apenas: ok',
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'hangar/0.1.0' },
        settings: Object.keys(settingsEnv).length ? { env: settingsEnv } : undefined,
        model,
        maxTurns: 1,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        abortController: abort
      }
    })
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        answered ??= msg.model
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        failure = msg.error_status
          ? `HTTP ${msg.error_status} (${msg.error})`
          : 'sem resposta (conexão recusada, DNS ou timeout)'
        if (msg.attempt >= 2) {
          abort.abort()
          break
        }
      } else if (msg.type === 'assistant') {
        answered = msg.message.model || answered
        if (msg.error) failure = `erro ${msg.error}`
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) failure = undefined
        else
          failure =
            (msg.subtype === 'success' ? msg.result : msg.errors.join('\n'))?.trim() ||
            failure ||
            'a consulta terminou com erro'
        break
      }
    }
    q.close()
  } catch (err) {
    failure ??= err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }
  const latencyMs = Date.now() - started
  return failure
    ? { ok: false, model: answered ?? model, latencyMs, error: maskSecrets(failure) }
    : { ok: true, model: answered ?? model, latencyMs }
}
