// The model bench's tasks: every check must fail on the untouched fixture and pass on a reference solution,
// otherwise the bench would measure the checks instead of the models. Also the scoring and the price table.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runNode, seeded, TASKS } from '../../src/main/features/bench/tasks'

vi.mock('electron', async () => (await import('./helpers/electron')).default)

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'hangar-bench-test-'))
  dirs.push(d)
  return d
}

const edit = (dir: string, file: string, from: string | RegExp, to: string) => {
  const p = join(dir, file)
  writeFileSync(p, readFileSync(p, 'utf8').replace(from, to))
}

/** What a model that does the task right leaves behind. */
const SOLUTIONS: Record<string, (dir: string, ctx: Record<string, unknown>) => void> = {
  'write-exact': (dir, ctx) => writeFileSync(join(dir, 'greeting.txt'), `${String(ctx.expected)}\n`),
  'edit-config': (dir) => {
    edit(dir, 'config.json', '"port": 3000', '"port": 8080')
    edit(dir, 'config.json', '"debug": true', '"debug": false')
    edit(dir, 'config.json', '"pool": 10', '"pool": 25')
  },
  'fix-bug': (dir) => {
    edit(dir, 'stats.js', '(values.length - 1)', 'values.length')
    edit(dir, 'stats.js', '.sort()', '.sort((a, b) => a - b)')
  },
  'find-symbol': (dir, ctx) => writeFileSync(join(dir, 'answer.txt'), String(ctx.target)),
  'run-script': (dir) => writeFileSync(join(dir, 'result.txt'), runNode(dir, ['gen.js']).out),
  'count-log': (dir) => {
    const n = readFileSync(join(dir, 'app.log'), 'utf8')
      .split('\n')
      .filter((l) => / ERROR code=E42 /.test(l)).length
    writeFileSync(join(dir, 'count.txt'), `${n}\n`)
  },
  'rename-symbol': (dir) => {
    for (const f of ['users.js', 'orders.js', 'main.js']) edit(dir, f, /getUser/g, 'fetchUser')
  },
  'implement-module': (dir) =>
    writeFileSync(
      join(dir, 'slug.js'),
      "module.exports = { slugify: (t) => t.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') }\n"
    )
}

describe('bench tasks', () => {
  it('has a reference solution for every task', () => {
    expect(Object.keys(SOLUTIONS).sort()).toEqual(TASKS.map((t) => t.id).sort())
  })

  for (const task of TASKS) {
    it(`${task.id}: fails untouched, passes when solved, same fixture for the same seed`, () => {
      const dir = fresh()
      const ctx = task.setup(dir, seeded(42))
      expect(task.prompt(ctx).length).toBeGreaterThan(20)
      expect(task.check(dir, ctx).ok).toBe(false)
      SOLUTIONS[task.id](dir, ctx)
      expect(task.check(dir, ctx)).toEqual({ ok: true })
      expect(task.setup(fresh(), seeded(42))).toEqual(ctx)
    })
  }

  it('rejects a half-done rename and a changed test file', () => {
    const rename = TASKS.find((t) => t.id === 'rename-symbol')!
    const dir = fresh()
    rename.setup(dir, seeded(1))
    edit(dir, 'users.js', /getUser/g, 'fetchUser')
    expect(rename.check(dir, {})).toMatchObject({ ok: false })

    const fix = TASKS.find((t) => t.id === 'fix-bug')!
    const d2 = fresh()
    const ctx = fix.setup(d2, seeded(1))
    writeFileSync(join(d2, 'test.js'), "console.log('ok')\n")
    expect(fix.check(d2, ctx)).toMatchObject({ ok: false, reason: 'test.js foi alterado.' })
  })
})

describe('bench scoring', async () => {
  const { priceFor, scoreResults } = await import('../../src/main/features/bench/run')
  const base = {
    taskId: 't',
    model: 'gpt-4o-mini',
    variant: 'hangar' as const,
    repeat: 0,
    durationMs: 1000,
    turns: 4,
    toolCalls: 3,
    toolErrors: 1,
    invalidToolCalls: 0,
    apiRetries: 0,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    costUsd: 0.01
  }

  it('aggregates per model and variant', () => {
    const scores = scoreResults([
      { ...base, ok: true },
      { ...base, ok: false, toolErrors: 2 },
      { ...base, ok: false, variant: 'baseline', apiError: true, toolCalls: 0, toolErrors: 0 }
    ])
    const hangar = scores.find((s) => s.variant === 'hangar')!
    expect(hangar).toMatchObject({ runs: 2, passed: 1, successRate: 0.5, avgToolCalls: 3, toolErrorRate: 0.5 })
    expect(scores.find((s) => s.variant === 'baseline')).toMatchObject({ runs: 1, passed: 0, apiErrors: 1 })
  })

  it('prices known models and errs high on unknown ones', () => {
    expect(priceFor('openai/gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 })
    expect(priceFor('gpt-4o')).toEqual({ input: 2.5, output: 10 })
    expect(priceFor('meu-modelo').input).toBeGreaterThanOrEqual(3)
    expect(priceFor('x', { x: { input: 0.1, output: 0.2 } })).toEqual({ input: 0.1, output: 0.2 })
  })
})
