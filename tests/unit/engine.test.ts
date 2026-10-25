import { afterAll, describe, expect, it, vi } from 'vitest'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)
const userData = useTempUserData()
afterAll(() => userData.cleanup())

const convert = await import('../../src/main/features/engine/convert')
const { isProviderFailure, maskSecrets } = await import('../../src/main/features/engine/providers')
const { isMotionPath } = await import('../../src/main/features/engine/motion')
const { toCommandInfo } = await import('../../src/main/features/engine/sdk')

describe('convert', () => {
  it('fromAssistantContent: text, thinking and tool_use (blank text dropped, parent id kept)', () => {
    const drafts = convert.fromAssistantContent(
      [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Olá' },
        { type: 'text', text: '   ' },
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'a.txt' } },
        { type: 'tool_use', name: 'NoId' },
        null
      ],
      'parent1'
    )
    expect(drafts).toEqual([
      { kind: 'thinking', text: 'hmm' },
      { kind: 'assistant', text: 'Olá', parentToolUseId: 'parent1' },
      { kind: 'tool_use', toolUseId: 'tu1', name: 'Write', input: { file_path: 'a.txt' }, parentToolUseId: 'parent1' }
    ])
    expect(convert.fromAssistantContent('só texto')).toEqual([{ kind: 'assistant', text: 'só texto' }])
  })

  it('toolResultsFromUserContent and toolResultText (images, truncation)', () => {
    const [r] = convert.toolResultsFromUserContent([
      { type: 'text', text: 'ignored prompt text' },
      {
        type: 'tool_result',
        tool_use_id: 'tu1',
        is_error: true,
        content: [{ type: 'text', text: 'falhou' }, { type: 'image' }]
      }
    ])
    expect(r).toEqual({ kind: 'tool_result', toolUseId: 'tu1', content: 'falhou\n[imagem]', isError: true })
    const long = convert.toolResultText('x'.repeat(31_000))
    expect(long.length).toBeLessThan(31_000)
    expect(long).toMatch(/saída truncada\)$/)
  })

  it('promptTextFromUserContent skips CLI wrappers and reminders', () => {
    expect(
      convert.promptTextFromUserContent([
        { type: 'text', text: '<system-reminder>x</system-reminder>' },
        { type: 'text', text: '<local-command-stdout>y</local-command-stdout>' },
        { type: 'text', text: 'Caveat: z' },
        { type: 'text', text: '<hangar-output-mode name="motion">guide</hangar-output-mode>' },
        { type: 'text', text: 'Crie um arquivo' }
      ])
    ).toBe('Crie um arquivo')
    expect(convert.promptTextFromUserContent([{ type: 'text', text: '<system-reminder>x' }])).toBeUndefined()
  })

  it('parseQuestions normalizes AskUserQuestion input', () => {
    expect(
      convert.parseQuestions({
        questions: [
          {
            question: 'Qual?',
            header: 'H',
            multiSelect: true,
            options: [{ label: 'A', description: 'a' }, { label: 'B' }, 7]
          },
          null
        ]
      })
    ).toEqual([
      {
        question: 'Qual?',
        header: 'H',
        multiSelect: true,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: undefined }
        ]
      }
    ])
    expect(convert.parseQuestions({})).toBeUndefined()
  })

  it('writtenPath only for file-writing tools', () => {
    expect(convert.writtenPath('Write', { file_path: 'C:/p/a.html' })).toBe('C:/p/a.html')
    expect(convert.writtenPath('Edit', { file_path: 'b.md' })).toBe('b.md')
    expect(convert.writtenPath('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb')
    expect(convert.writtenPath('Read', { file_path: 'a' })).toBeUndefined()
    expect(convert.writtenPath('Write', { file_path: 3 })).toBeUndefined()
  })
})

describe('provider failures and masking', () => {
  it.each([
    ['API Error: 401 {"type":"authentication_error"}', true],
    ['Invalid API key · Please run /login', true],
    ['connect ECONNREFUSED 127.0.0.1:8787', true],
    ['self-signed certificate in certificate chain', true],
    ['model claude-x not found', true],
    ['The test suite failed with 3 errors', false],
    ['TypeError: cannot read property of undefined', false]
  ])('isProviderFailure(%s) → %s', (text, expected) => {
    expect(isProviderFailure(text)).toBe(expected)
  })

  it('maskSecrets removes the launch secrets and credential-shaped text', () => {
    const out = maskSecrets('token=abc123secret Bearer eyJhbGciOi sk-ant-api03-ABCDEFGHIJ my-secret-value!', [
      'my-secret-value'
    ])
    expect(out).not.toContain('abc123secret')
    expect(out).not.toContain('eyJhbGciOi')
    expect(out).not.toContain('ABCDEFGHIJ')
    expect(out).not.toContain('my-secret-value')
  })
})

describe('small helpers', () => {
  it('isMotionPath', () => {
    expect(isMotionPath('C:/x/Intro.MOTION.json')).toBe(true)
    expect(isMotionPath('a.json')).toBe(false)
  })

  it('toCommandInfo drops empty argument hints', () => {
    expect(toCommandInfo({ name: 'review', description: 'd', argumentHint: '' })).toEqual({
      name: 'review',
      description: 'd',
      argumentHint: undefined
    })
  })
})
