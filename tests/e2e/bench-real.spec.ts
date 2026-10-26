// Opt-in: the model bench against REAL models through one of your Hangar provider profiles (costs money).
//
//   HANGAR_BENCH_PROFILE   profile name or id (required; e.g. "LiteLLM (avaliação)")
//   HANGAR_BENCH_MODELS    comma-separated model ids (default: the profile's default + extra models)
//   HANGAR_BENCH_VARIANTS  default "baseline,hangar"
//   HANGAR_BENCH_TASKS     comma-separated task ids (default: all)
//   HANGAR_BENCH_REPEATS   default 1
//   HANGAR_BENCH_BUDGET    USD, estimated (default 1)
//   HANGAR_BENCH_USERDATA  Hangar userData to take the profile from (default %APPDATA%/hangar)
//
// The app under test starts with a copy of that folder's provider profiles and encrypted keys and decrypts them
// itself (fixtures.ts → seedProvidersFrom); this file never sees a key. Reports land in bench-results/.
//
// Without a Hangar profile, a throwaway gateway profile can be created inside the test app instead:
//   HANGAR_BENCH_BASE_URL  gateway URL (e.g. http://localhost:4000); HANGAR_BENCH_PROFILE is then its name
//   HANGAR_BENCH_KEY_FILE  file holding a test key for that gateway (read here, stored only in the temp userData)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, REPO_ROOT, test } from './fixtures'

const PROFILE = process.env.HANGAR_BENCH_PROFILE
const BASE_URL = process.env.HANGAR_BENCH_BASE_URL
const KEY_FILE = process.env.HANGAR_BENCH_KEY_FILE
const USERDATA = process.env.HANGAR_BENCH_USERDATA ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'hangar')
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

interface Profile {
  id: string
  name: string
  models?: { default?: string; extra?: string[] }
}
interface Score {
  model: string
  variant: string
  runs: number
  passed: number
  successRate: number
  avgTurns: number
  avgToolCalls: number
  toolErrorRate: number
  invalidToolCalls: number
  apiErrors: number
  avgDurationMs: number
  tokens: number
  costUsd: number
  repairs: number
}
interface Run {
  id: string
  status: string
  finished: number
  planned: number
  costUsd: number
  error?: string
  scores: Score[]
  results: {
    taskId: string
    model: string
    variant: string
    ok: boolean
    reason?: string
    turns: number
    toolCalls: number
    toolErrors: number
    toolErrorSamples?: string[]
    costUsd: number
  }[]
}

test.use({ seedProvidersFrom: PROFILE && !BASE_URL ? USERDATA : undefined })
test.skip(!PROFILE, 'HANGAR_BENCH_PROFILE not set')

test('model bench on real models', async ({ hangar }) => {
  test.setTimeout(4 * 60 * 60_000)
  if (BASE_URL) {
    const created = await hangar.invoke<{ id: string }>('settings:providerSave', {
      name: PROFILE,
      kind: 'gateway',
      baseUrl: BASE_URL,
      authStyle: 'bearer',
      extraEnv: { DISABLE_AUTOUPDATER: '1' }
    })
    if (KEY_FILE) await hangar.invoke('settings:providerSetSecret', created.id, readFileSync(KEY_FILE, 'utf8').trim())
  }
  const { profiles } = await hangar.invoke<{ profiles: Profile[] }>('settings:providersList')
  const profile = profiles.find((p) => p.id === PROFILE || p.name === PROFILE)
  expect(profile, `perfil "${PROFILE}" não encontrado em ${USERDATA}`).toBeTruthy()

  let models = list(process.env.HANGAR_BENCH_MODELS)
  if (!models.length)
    models = [profile!.models?.default, ...(profile!.models?.extra ?? [])].filter((m): m is string => !!m)
  if (!models.length) models = (await hangar.invoke<string[]>('bench:models', profile!.id)).slice(0, 3)
  expect(models.length, 'nenhum modelo: defina HANGAR_BENCH_MODELS').toBeGreaterThan(0)

  const runId = await hangar.invoke<string>('bench:run', {
    providerId: profile!.id,
    models,
    variants: list(process.env.HANGAR_BENCH_VARIANTS).length
      ? list(process.env.HANGAR_BENCH_VARIANTS)
      : ['baseline', 'hangar'],
    taskIds: list(process.env.HANGAR_BENCH_TASKS),
    repeats: Number(process.env.HANGAR_BENCH_REPEATS ?? 1),
    maxCostUsd: Number(process.env.HANGAR_BENCH_BUDGET ?? 1)
  })
  console.log(`[bench] run ${runId}: ${models.join(', ')}`)

  let last = -1
  let run: Run
  for (;;) {
    run = await hangar.invoke<Run>('bench:get', runId)
    if (run.finished !== last) {
      last = run.finished
      const r = run.results.at(-1)
      if (r)
        console.log(
          `[bench] ${run.finished}/${run.planned} ${r.model} ${r.variant} ${r.taskId}: ${r.ok ? 'OK' : 'FALHOU'} ` +
            `(${r.turns} turnos, ${r.toolCalls} ferramentas, ${r.toolErrors} erros, US$ ${r.costUsd.toFixed(4)})` +
            (r.ok ? '' : ` — ${r.reason ?? ''}`)
        )
    }
    if (run.status !== 'running') break
    await new Promise((r) => setTimeout(r, 3000))
  }

  // Outside test-results/, which Playwright empties on every run.
  const dir = join(REPO_ROOT, 'bench-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(run, null, 2))
  const rows = run.scores
    .sort((a, b) => a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant))
    .map(
      (s) =>
        `| ${s.model} | ${s.variant} | ${s.passed}/${s.runs} (${Math.round(s.successRate * 100)}%) | ${s.avgTurns.toFixed(1)} | ` +
        `${s.avgToolCalls.toFixed(1)} | ${Math.round(s.toolErrorRate * 100)}% | ${s.invalidToolCalls} | ${s.apiErrors} | ` +
        `${(s.avgDurationMs / 1000).toFixed(0)} s | ${s.repairs} | ${s.costUsd.toFixed(3)} |`
    )
  const md = [
    `# Bench ${runId} (${run.status}${run.error ? `: ${run.error}` : ''})`,
    '',
    '| Modelo | Variante | Sucesso | Turnos | Ferramentas | Erros de ferramenta | Chamadas inválidas | Erros de API | Tempo médio | Reparos | US$ (est.) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Falhas',
    ...run.results.filter((r) => !r.ok).map((r) => `- ${r.model} · ${r.variant} · ${r.taskId}: ${r.reason ?? ''}`),
    '',
    '## Erros de ferramenta (amostras)',
    ...run.results
      .filter((r) => r.toolErrorSamples?.length)
      .flatMap((r) => r.toolErrorSamples!.map((e) => `- ${r.model} · ${r.variant} · ${r.taskId} · ${e}`))
  ].join('\n')
  writeFileSync(join(dir, `${runId}.md`), md)
  console.log(`\n${md}\n`)
  expect(['done', 'stopped']).toContain(run.status)
})
