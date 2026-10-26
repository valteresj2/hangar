// Model bench + compat layer, end to end and offline: the mock's "mock-gpt" model behaves like a strict non-Claude
// model behind a gateway (rejects Anthropic-only fields, names tools like other harnesses). Without the compat layer
// ("baseline") every request is refused; with it ("hangar") the request is adapted, the tool call repaired and the
// task delivered.
import { expect, test } from './fixtures'

interface Result {
  taskId: string
  variant: string
  ok: boolean
  apiError?: boolean
  reason?: string
  toolCalls: number
  compat?: { adaptedRequests: number; repairs: { name: number; args: number } }
}
interface Run {
  status: string
  finished: number
  planned: number
  results: Result[]
  scores: { variant: string; successRate: number }[]
}

test('the compat layer lets a strict non-Claude model deliver a task the baseline cannot', async ({ hangar, mock }) => {
  const providerId = await hangar.useMockProvider({ name: 'Gateway falso (mock-gpt)' })
  const tasks = await hangar.invoke<{ id: string }[]>('bench:tasks')
  expect(tasks.map((t) => t.id)).toContain('write-exact')

  const runId = await hangar.invoke<string>('bench:run', {
    providerId,
    models: ['mock-gpt-4o'],
    variants: ['baseline', 'hangar'],
    taskIds: ['write-exact'],
    maxTurns: 6
  })
  await expect
    .poll(async () => (await hangar.invoke<Run>('bench:get', runId))?.status, { timeout: 100_000, intervals: [1000] })
    .toBe('done')
  const run = await hangar.invoke<Run>('bench:get', runId)
  expect(run.finished).toBe(2)

  const baseline = run.results.find((r) => r.variant === 'baseline')!
  const adapted = run.results.find((r) => r.variant === 'hangar')!
  expect(baseline.ok).toBe(false)
  expect(baseline.reason ?? '').toMatch(/400|Extra inputs|invalid/i)
  expect(adapted.ok, adapted.reason).toBe(true)
  expect(adapted.toolCalls).toBeGreaterThanOrEqual(1)
  expect(adapted.compat?.adaptedRequests).toBeGreaterThanOrEqual(2)
  expect(adapted.compat?.repairs.name).toBeGreaterThanOrEqual(1)
  expect(adapted.compat?.repairs.args).toBeGreaterThanOrEqual(1)
  expect(run.scores.find((s) => s.variant === 'hangar')?.successRate).toBe(1)

  // What reached the "gateway" from the hangar variant: no Anthropic-only fields, max_tokens within the model's limit.
  const adaptedBodies = mock.messages().filter((m) => m.model === 'mock-gpt-4o' && m.output_config === undefined)
  expect(adaptedBodies.length).toBeGreaterThan(0)
  for (const b of adaptedBodies) expect(b.max_tokens ?? 0).toBeLessThanOrEqual(8192)

  const list = await hangar.invoke<{ id: string }[]>('bench:list')
  expect(list[0].id).toBe(runId)
})
