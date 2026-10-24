import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { componentOf, isHarnessPath } from '@shared/harness'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)

const userData = useTempUserData()
const { readHarness, writeHarness } = await import('../../src/main/features/harness/api')

describe('isHarnessPath', () => {
  it.each([
    ['CLAUDE.md', true],
    ['.claude/CLAUDE.md', true],
    ['.claude/skills/deploy/SKILL.md', true],
    ['.claude/skills/deploy/scripts/run.sh', true],
    ['.claude/agents/reviewer.md', true],
    ['.claude/commands/ship.md', true],
    ['.claude/commands/team/review.md', true],
    ['.claude/settings.json', true],
    ['.claude/scripts/check.ps1', true],
    ['.claude\\agents\\reviewer.md', true],
    ['README.md', false],
    ['src/CLAUDE.md', false],
    ['.claude/settings.local.json', false],
    ['.claude/skills/SKILL.md', false],
    ['.claude/agents/nested/x.md', false],
    ['.claude/commands/notes.txt', false],
    ['.claude/launch.json', false],
    ['/CLAUDE.md', false],
    ['.claude/skills/../../etc/passwd', false]
  ])('%s → %s', (path, expected) => {
    expect(isHarnessPath(path)).toBe(expected)
  })
})

describe('componentOf', () => {
  it('groups harness paths by component', () => {
    expect(componentOf('CLAUDE.md')).toEqual({ kind: 'instructions', name: 'CLAUDE.md' })
    expect(componentOf('.claude/CLAUDE.md')).toEqual({ kind: 'instructions', name: '.claude/CLAUDE.md' })
    expect(componentOf('.claude/skills/deploy/scripts/run.sh')).toEqual({ kind: 'skill', name: 'deploy' })
    expect(componentOf('.claude/agents/reviewer.md')).toEqual({ kind: 'subagent', name: 'reviewer' })
    expect(componentOf('.claude/commands/team/review.md')).toEqual({ kind: 'command', name: 'team/review.md' })
    expect(componentOf('.claude/settings.json')).toEqual({ kind: 'settings', name: '.claude/settings.json' })
    expect(componentOf('.claude\\scripts\\a\\b.ps1')).toEqual({ kind: 'script', name: 'a/b.ps1' })
    expect(componentOf('src/index.ts')).toBeUndefined()
  })
})

describe('readHarness / writeHarness', () => {
  let dir: string
  const put = (rel: string, content: string | Buffer) => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-harness-'))
    put('CLAUDE.md', '# Projeto\n')
    put('.claude/settings.json', '{"permissions":{}}')
    put('.claude/skills/old/SKILL.md', '---\nname: old\ndescription: x\n---\n')
    put('.claude/commands/ship.md', 'Ship it')
    // Not harness: must never be read, written or deleted.
    put('README.md', 'readme')
    put('src/index.ts', 'export {}')
    put('.claude/settings.local.json', '{"local":true}')
    put('.claude/launch.json', '{}')
    put('node_modules/pkg/CLAUDE.md', 'vendored')
    // Harness, but not representable in a tree: binary and too large.
    put('.claude/scripts/tool.bin', Buffer.from([0, 1, 2, 3]))
    put('.claude/scripts/huge.txt', 'x'.repeat(300 * 1024))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  afterAll(() => userData.cleanup())

  it('reads only text harness files', async () => {
    const tree = await readHarness(dir)
    expect(Object.keys(tree).sort()).toEqual(['.claude/commands/ship.md', '.claude/settings.json', '.claude/skills/old/SKILL.md', 'CLAUDE.md'])
    expect(tree['CLAUDE.md']).toBe('# Projeto\n')
  })

  it('makes the harness surface match the tree and leaves everything else alone', async () => {
    await writeHarness(dir, {
      'CLAUDE.md': '# Projeto v2\n',
      '.claude/settings.json': '{"permissions":{}}',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: revisa\n---\n',
      '.claude/skills/new/SKILL.md': '---\nname: new\ndescription: y\n---\n'
    })
    expect(read('CLAUDE.md')).toBe('# Projeto v2\n')
    expect(read('.claude/agents/reviewer.md')).toContain('reviewer')
    expect(read('.claude/skills/new/SKILL.md')).toContain('name: new')
    // Removed from the tree → deleted, and the emptied skill folder is pruned (but .claude stays).
    expect(existsSync(join(dir, '.claude/commands/ship.md'))).toBe(false)
    expect(existsSync(join(dir, '.claude/skills/old'))).toBe(false)
    expect(existsSync(join(dir, '.claude'))).toBe(true)
    // Untouched: non-harness files and harness files a tree cannot carry.
    expect(read('README.md')).toBe('readme')
    expect(read('src/index.ts')).toBe('export {}')
    expect(read('.claude/settings.local.json')).toBe('{"local":true}')
    expect(read('.claude/launch.json')).toBe('{}')
    expect(read('node_modules/pkg/CLAUDE.md')).toBe('vendored')
    expect(existsSync(join(dir, '.claude/scripts/tool.bin'))).toBe(true)
    expect(existsSync(join(dir, '.claude/scripts/huge.txt'))).toBe(true)

    expect(await readHarness(dir)).toEqual({
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: revisa\n---\n',
      '.claude/settings.json': '{"permissions":{}}',
      '.claude/skills/new/SKILL.md': '---\nname: new\ndescription: y\n---\n',
      'CLAUDE.md': '# Projeto v2\n'
    })
  })

  it('refuses trees with paths off the harness surface, before touching anything', async () => {
    await expect(writeHarness(dir, { 'CLAUDE.md': 'changed', 'src/evil.ts': 'x' })).rejects.toThrow(/Fora da superfície de harness: src\/evil\.ts/)
    await expect(writeHarness(dir, { '../outside/CLAUDE.md': 'x' })).rejects.toThrow(/Fora da superfície/)
    expect(read('CLAUDE.md')).toBe('# Projeto\n')
    expect(existsSync(join(dir, 'src/evil.ts'))).toBe(false)
  })
})
