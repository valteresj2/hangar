import { afterAll, describe, expect, it, vi } from 'vitest'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)
const userData = useTempUserData()
afterAll(() => userData.cleanup())

const { parseReflection, treeDiffText } = await import('../../src/main/features/harness/reflector')

const FULL = `Some reasoning first.

<edits>
component: CLAUDE.md
candidates: B
change: added a "run the tests before answering" rule
observed: B ran the suite and caught the failing import
verdict: helped

- **component**: .claude/skills/deploy
- **candidates**: C
- **change**: new deploy skill
- **observed**: never triggered;
  the task had no deploy step
- **verdict**: \`no effect\`

component: none
change: nothing else
verdict: confounded
</edits>

<experience>
cue: tasks that change a module imported elsewhere
lesson: tell the agent to run the full test suite, not only the touched file
evidence: B ran the suite and fixed the import; A shipped it broken
confidence: high — same failure in two runs
</experience>`

describe('parseReflection', () => {
  it('parses edit rows (plain and bulleted, multi-line values) and drops "none"', () => {
    const r = parseReflection(FULL)
    expect(r.edits).toEqual([
      {
        component: 'CLAUDE.md',
        candidates: 'B',
        change: 'added a "run the tests before answering" rule',
        observed: 'B ran the suite and caught the failing import',
        verdict: 'helped'
      },
      {
        component: '.claude/skills/deploy',
        candidates: 'C',
        change: 'new deploy skill',
        observed: 'never triggered;\nthe task had no deploy step',
        verdict: 'no observed effect'
      }
    ])
  })

  it('parses the experience block and splits the confidence rationale', () => {
    const r = parseReflection(FULL)
    expect(r.experience).toEqual({
      cue: 'tasks that change a module imported elsewhere',
      lesson: 'tell the agent to run the full test suite, not only the touched file',
      evidence: 'B ran the suite and fixed the import; A shipped it broken\n(confidence: same failure in two runs)',
      confidence: 'high'
    })
  })

  it('NO_ENTRY: edit rows but no lesson', () => {
    const r = parseReflection(
      '<edits>\ncomponent: CLAUDE.md\ncandidates: B\nchange: x\nobserved: y\nverdict: hurt\n</edits>\n\nNO_ENTRY'
    )
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0].verdict).toBe('hurt')
    expect(r.experience).toBeUndefined()
  })

  it('an incomplete experience is not a lesson; unknown confidence defaults to low', () => {
    expect(parseReflection('<experience>\ncue: x\nlesson: y\n</experience>').experience).toBeUndefined()
    expect(
      parseReflection('<experience>\ncue: x\nlesson: y\nevidence: z\nconfidence: maybe\n</experience>').experience
        ?.confidence
    ).toBe('low')
  })

  it('tolerates a truncated (unterminated) block and odd verdicts', () => {
    const r = parseReflection('<edits>\ncomponent: CLAUDE.md\nverdict: **Helped** a lot\n\ncomponent: x\nverdict: ???')
    expect(r.edits.map((e) => e.verdict)).toEqual(['helped', 'confounded'])
  })

  it('returns no edits for unrelated text', () => {
    expect(parseReflection('I could not analyse this.')).toEqual({ edits: [] })
  })
})

describe('treeDiffText', () => {
  it('lists added, removed and changed harness files', () => {
    const text = treeDiffText(
      { 'CLAUDE.md': 'a\n', '.claude/commands/x.md': 'x' },
      { 'CLAUDE.md': 'b\n', '.claude/agents/r.md': 'r' }
    )
    expect(text).toContain('### CLAUDE.md (modified)')
    expect(text).toContain('-a')
    expect(text).toContain('+b')
    expect(text).toContain('### .claude/agents/r.md (added)')
    expect(text).toContain('### .claude/commands/x.md (deleted)')
    expect(treeDiffText({ 'CLAUDE.md': 'same' }, { 'CLAUDE.md': 'same' })).toBe('(no harness change against the base)')
  })
})
