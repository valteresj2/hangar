// Lab parsers, exercised through the real functions with the Agent SDK replaced by a scripted fake:
// the selector's ```choice``` + <why>, and a proposer stage's <notes> / KEEP_BASE / fallback handling.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { anonId, type BlindCandidate } from '@shared/features/lab'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)

/** What the fake `query()` does: optional side effect in its cwd, then assistant text and a result. */
interface FakeTurn {
  text: string
  /** Called with the query's cwd before replying (e.g. to edit harness/ like the real proposer would). */
  act?: (cwd: string) => Promise<void>
  result?: 'success' | 'error_during_execution'
}
const turns: FakeTurn[] = []
const prompts: string[] = []

vi.mock('../../src/main/features/engine/sdk', () => ({
  claudeLaunchOptions: () => ({ env: {} }),
  loadSdk: async () => ({
    query: ({ prompt, options }: { prompt: string; options: { cwd: string } }) => {
      prompts.push(prompt)
      const turn = turns.shift() ?? { text: '' }
      return (async function* () {
        await turn.act?.(options.cwd)
        yield { type: 'assistant', message: { content: [{ type: 'text', text: turn.text }] } }
        if (turn.result === 'error_during_execution') yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'], total_cost_usd: 0.01 }
        else yield { type: 'result', subtype: 'success', result: turn.text, total_cost_usd: 0.02 }
      })()
    }
  })
}))

const userData = useTempUserData()
const { askClaude, makeBlindMap } = await import('../../src/main/features/lab/select')
const { runStage } = await import('../../src/main/features/lab/propose')

afterAll(() => userData.cleanup())
beforeEach(() => {
  turns.length = 0
  prompts.length = 0
  delete process.env.HANGAR_LAB_TEST_INSTRUCTION
})

const candidates: BlindCandidate[] = ['A', 'B', 'C'].map((id) => ({ anonId: id, finalAnswer: `answer ${id}`, diffStat: '', diffExcerpt: '', diffTruncated: false, errors: [] }))

describe('blind ids', () => {
  it('anonId counts A…Z, AA…', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(anonId)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA'])
  })

  it('makeBlindMap is a permutation of the variants', () => {
    const map = makeBlindMap(['base', 'v1', 'v2', 'v3'])
    expect(Object.keys(map)).toEqual(['A', 'B', 'C', 'D'])
    expect(Object.values(map).sort()).toEqual(['base', 'v1', 'v2', 'v3'])
  })
})

describe('selector (askClaude)', () => {
  it('parses ```choice``` and <why>', async () => {
    turns.push({ text: '<why>\nB finished the task; A left a TODO.\n</why>\n\n```choice\nB\n```' })
    const r = await askClaude('the task', candidates)
    expect(r).toEqual({ anonId: 'B', why: 'B finished the task; A left a TODO.', costUsd: 0.02 })
    expect(prompts[0]).toContain('<candidate id="A">')
    expect(prompts[0]).toContain('the task')
  })

  it('accepts a lowercase id on the same line and a missing <why>', async () => {
    turns.push({ text: '```choice c```' })
    expect(await askClaude('t', candidates)).toMatchObject({ anonId: 'C', why: '' })
  })

  it('rejects an id that is not a candidate', async () => {
    turns.push({ text: '```choice\nZ\n```' })
    await expect(askClaude('t', candidates)).rejects.toThrow(/"Z", que não é um dos candidatos/)
  })

  it('reports a missing choice block (with the run error when there is one)', async () => {
    turns.push({ text: 'I pick B.' })
    await expect(askClaude('t', candidates)).rejects.toThrow(/bloco ```choice```/)
    turns.push({ text: 'nothing', result: 'error_during_execution' })
    await expect(askClaude('t', candidates)).rejects.toThrow('boom')
  })
})

describe('proposer stage (runStage)', () => {
  const baseTree = { 'CLAUDE.md': '# Base\n' }
  const input = (stageId: string) => ({
    roundId: 'r1',
    stageId,
    job: 'improve',
    task: 'Fix the bug',
    baseTree,
    currentTree: { ...baseTree },
    runs: [],
    candidates: [],
    lessons: [],
    examples: [],
    model: 'haiku',
    signal: new AbortController().signal
  })

  it('KEEP_BASE: unchanged harness, notes from <notes>', async () => {
    turns.push({ text: 'Looked at the evidence.\n<notes>\nKEEP_BASE\n</notes>' })
    const out = await runStage(input('keep'))
    expect(out).toMatchObject({ tree: baseTree, notes: 'KEEP_BASE', keptBase: true, fellBack: false, attempts: 1 })
    expect(out.costUsd).toBeCloseTo(0.02)
  })

  it('an edited harness/ becomes the proposal (notes fall back to the whole reply)', async () => {
    turns.push({
      text: 'Added a testing rule.',
      act: async (cwd) => writeFile(join(cwd, 'harness', 'CLAUDE.md'), '# Base\n\nAlways run the tests.\n', 'utf8')
    })
    const out = await runStage(input('edit'))
    expect(out).toMatchObject({ tree: { 'CLAUDE.md': '# Base\n\nAlways run the tests.\n' }, notes: 'Added a testing rule.', keptBase: false, fellBack: false })
  })

  it('files off the harness surface trigger a retry; a second failure inherits the current harness', async () => {
    const offSurface = async (cwd: string) => {
      await mkdir(join(cwd, 'harness', 'src'), { recursive: true })
      await writeFile(join(cwd, 'harness', 'src', 'app.ts'), 'export {}', 'utf8')
    }
    turns.push({ text: 'try 1', act: offSurface }, { text: 'try 2', act: offSurface })
    const out = await runStage(input('bad'))
    expect(out).toMatchObject({ tree: baseTree, keptBase: true, fellBack: true, attempts: 2 })
    expect(out.error).toMatch(/Proposta inválida duas vezes/)
    // The retry prompt tells the proposer what was wrong.
    expect(prompts[1]).toContain('src/app.ts')
  })

  it('an invalid skill (no frontmatter) is retried and can be fixed on the second attempt', async () => {
    turns.push(
      { text: 'v1', act: async (cwd) => { await mkdir(join(cwd, 'harness/.claude/skills/x'), { recursive: true }); await writeFile(join(cwd, 'harness/.claude/skills/x/SKILL.md'), 'no frontmatter', 'utf8') } },
      { text: '<notes>fixed</notes>', act: async (cwd) => writeFile(join(cwd, 'harness/.claude/skills/x/SKILL.md'), '---\nname: x\ndescription: when x\n---\nbody', 'utf8') }
    )
    const out = await runStage(input('fix'))
    expect(out).toMatchObject({ notes: 'fixed', fellBack: false, attempts: 2 })
    expect(out.tree['.claude/skills/x/SKILL.md']).toContain('name: x')
    expect(prompts[1]).toMatch(/frontmatter/)
  })

  it('a failed call inherits right away, and the test hook instruction reaches the mission', async () => {
    process.env.HANGAR_LAB_TEST_INSTRUCTION = '[[script:text]] hook'
    turns.push({ text: '', result: 'error_during_execution' })
    const out = await runStage(input('fail'))
    expect(out).toMatchObject({ fellBack: true, keptBase: true, error: 'boom', attempts: 1 })
    expect(prompts[0]).toContain('# TEST INSTRUCTION')
    expect(prompts[0]).toContain('[[script:text]] hook')
    expect(existsSync(join(userData.dir, 'hangar-data', 'lab', 'ctx', 'r1', 'fail', 'task.md'))).toBe(true)
  })
})
