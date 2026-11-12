// The Hangar engine: pure mappings, and a real HangarRunner driving the real Python bridge (resources/harness)
// against a scripted OpenAI-compatible server. No network and no API key; the second part is skipped when the
// machine has no Python 3.11+.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { useTempUserData } from './helpers/electron'
import type { TranscriptEntry } from '../../src/shared/features/engine'
import { startMockOpenAI } from '../mock-openai/server.ts'

vi.mock('electron', async () => (await import('./helpers/electron')).default)
const userData = useTempUserData()
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.env.HANGAR_HARNESS_DIR = join(REPO, 'resources', 'harness')

const map = await import('../../src/main/features/engine/hangar/map')

describe('hangar engine: mappings', () => {
  it('permission modes and effort', () => {
    expect(map.permissionFor('default')).toBe('ask')
    expect(map.permissionFor(undefined)).toBe('ask')
    expect(map.permissionFor('acceptEdits')).toBe('edits')
    expect(map.permissionFor('plan')).toBe('readonly')
    expect(map.permissionFor('auto')).toBe('auto')
    expect(map.permissionFor('bypassPermissions')).toBe('auto')
    expect(map.effortFor('low')).toBe('low')
    expect(map.effortFor('max')).toBe('high')
    expect(map.effortFor(undefined)).toBe('high')
  })

  it('the OpenAI base URL of a gateway profile', () => {
    expect(map.openAiBaseUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1')
    expect(map.openAiBaseUrl('http://localhost:4000/')).toBe('http://localhost:4000/v1')
    expect(map.openAiBaseUrl('https://gw.empresa.com/v1')).toBe('https://gw.empresa.com/v1')
  })

  it('model aliases resolve through the profile', () => {
    const models = { default: 'openai/gpt-x', opus: 'big/model' }
    expect(map.resolveModel(undefined, models)).toBe('openai/gpt-x')
    expect(map.resolveModel('opus', models)).toBe('big/model')
    expect(map.resolveModel('sonnet', models)).toBe('openai/gpt-x')
    expect(map.resolveModel('qwen/qwen3', models)).toBe('qwen/qwen3')
    expect(map.resolveModel('opus', undefined)).toBeUndefined()
  })

  it('harness tools become the Claude Code tools the interface draws', () => {
    const cwd = resolve(tmpdir(), 'proj')
    expect(map.mapTool('edit', { path: 'src/a.ts', old: 'x', new: 'y', all: true }, cwd)).toEqual({
      name: 'Edit',
      input: { file_path: join(cwd, 'src', 'a.ts'), old_string: 'x', new_string: 'y', replace_all: true }
    })
    expect(map.mapTool('write', { path: join(cwd, 'b.txt'), content: 'oi' }, cwd).input.file_path).toBe(
      join(cwd, 'b.txt')
    )
    expect(map.mapTool('shell', { command: 'npm test', background: true }, cwd)).toEqual({
      name: 'Bash',
      input: { command: 'npm test', run_in_background: true }
    })
    expect(map.mapTool('plan', { items: [{ step: 'ler', status: 'done' }, 'escrever'] }, cwd).input).toEqual({
      todos: [
        { content: 'ler', status: 'completed', activeForm: 'ler' },
        { content: 'escrever', status: 'pending', activeForm: 'escrever' }
      ]
    })
    expect(map.mapTool('ask_user', { question: 'Qual?', options: ['a', 'b'] }, cwd)).toEqual({
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Qual?', options: [{ label: 'a' }, { label: 'b' }] }] }
    })
    expect(map.mapTool('mcp_call', { name: 'agent-hangar__list_agents', arguments: { q: 1 } }, cwd)).toEqual({
      name: 'mcp__agent-hangar__list_agents',
      input: { q: 1 }
    })
    expect(map.mapTool('mcp__agent-hangar__assign_task', { a: 1 }, cwd).name).toBe('mcp__agent-hangar__assign_task')
    expect(map.mapTool('perceive', { path: 'x.png' }, cwd)).toEqual({ name: 'perceive', input: { path: 'x.png' } })
  })

  it('token accounting and provider error kinds', () => {
    expect(map.freshInputTokens(1000, 700, 100)).toBe(200)
    expect(map.freshInputTokens(10, 700, 0)).toBe(0)
    expect(map.isProviderErrorKind('auth')).toBe(true)
    expect(map.isProviderErrorKind('bad_request')).toBe(false)
  })
})

function hasPython(): boolean {
  for (const [cmd, args] of [
    ['python', []],
    ['python3', []],
    ['py', ['-3']]
  ] as [string, string[]][]) {
    const r = spawnSync(cmd, [...args, '-c', 'import sys;sys.exit(0 if sys.version_info >= (3, 11) else 1)'], {
      timeout: 15_000
    })
    if (r.status === 0) return true
  }
  return false
}

const SECRET = 'sk-test-0123456789abcdefSECRET'

describe.skipIf(!hasPython())('hangar engine: a session on the real bridge', async () => {
  const fake = await startMockOpenAI()
  // The real (long) path: on Windows the temp folder may come in 8.3 form, and the harness reports resolved paths.
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'hangar-engine-work-')))
  const providers = await import('../../src/main/features/settings/providers')
  await providers.loadProviders()
  const { db } = await import('../../src/main/core/store')
  const { bus } = await import('../../src/main/core/bus')
  const registry = await import('../../src/main/features/engine/registry')
  const { readEntries } = await import('../../src/main/features/engine/transcript')

  const profile = providers.saveProvider({
    name: 'Gateway falso',
    kind: 'gateway',
    baseUrl: fake.url,
    authStyle: 'bearer',
    engine: 'hangar',
    models: { default: 'fake/model' }
  })
  await Promise.resolve().then(() => providers.setProviderSecret(profile.id, SECRET))
  const now = Date.now()
  db('sessions').put({
    id: 's1',
    title: 'Nova sessão',
    cwd: work,
    pinned: false,
    archived: false,
    unread: false,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    providerId: profile.id,
    permissionMode: 'default'
  })
  const written: string[] = []
  bus.on('session:file-written', (e: { path: string }) => written.push(e.path))

  afterAll(async () => {
    registry.closeAll()
    await fake.close()
    await new Promise((r) => setTimeout(r, 800))
    rmSync(work, { recursive: true, force: true })
    userData.cleanup()
  })

  const entries = () => readEntries('s1')
  async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 45_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = await probe()
      if (v) return v
      if (Date.now() > end) {
        const kinds = (await entries()).map((e) => e.kind).join(', ')
        throw new Error(`timed out waiting for ${what}; transcript: ${kinds}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const results = async () => (await entries()).filter((e) => e.kind === 'result')
  const byKind = <K extends TranscriptEntry['kind']>(list: TranscriptEntry[], kind: K) =>
    list.filter((e): e is Extract<TranscriptEntry, { kind: K }> => e.kind === kind)

  it('the profile picks the engine', () => {
    expect(registry.engineOf('s1')).toBe('hangar')
    expect(providers.listProviders().find((p) => p.id === profile.id)?.engine).toBe('hangar')
    expect(registry.runnerFor('s1').engine).toBe('hangar')
  })

  it('a turn with a permission card, a diff-ready tool call and the result line', { timeout: 90_000 }, async () => {
    fake.script = [
      { tool: 'write', args: { path: 'nota.txt', content: 'ola do hangar' }, thinking: 'vou criar o arquivo' },
      { text: 'Arquivo criado.' },
      { text: 'Arquivo criado e conferido.' }
    ]
    const runner = registry.runnerFor('s1')
    await runner.send('crie nota.txt')
    const pending = await until('the permission request', () => runner.state().pending[0])
    expect(pending.toolName).toBe('Write')
    expect(pending.input.file_path).toBe(join(work, 'nota.txt'))
    expect(pending.canAlwaysAllow).toBe(true)
    expect(existsSync(join(work, 'nota.txt'))).toBe(false)
    expect(db('sessions').get('s1')?.status).toBe('waiting')
    runner.respond(pending.requestId, { decision: 'allow' })
    await until('the result', async () => (await results())[0])

    const list = await entries()
    const kinds = list.map((e) => e.kind)
    for (const k of [
      'user',
      'thinking',
      'tool_use',
      'permission_request',
      'permission_decision',
      'tool_result',
      'assistant',
      'result'
    ])
      expect(kinds).toContain(k)
    expect(kinds.indexOf('permission_request')).toBeGreaterThan(kinds.indexOf('tool_use'))
    expect(kinds.indexOf('tool_result')).toBeGreaterThan(kinds.indexOf('permission_decision'))
    const use = byKind(list, 'tool_use')[0]
    expect(use.name).toBe('Write')
    expect(use.input).toEqual({ file_path: join(work, 'nota.txt'), content: 'ola do hangar' })
    expect(byKind(list, 'tool_result')[0]).toMatchObject({ toolUseId: use.toolUseId, isError: false })
    expect(readFileSync(join(work, 'nota.txt'), 'utf8')).toBe('ola do hangar')
    expect(written).toContain(join(work, 'nota.txt'))

    const result = byKind(list, 'result')[0]
    expect(result).toMatchObject({
      subtype: 'success',
      isError: false,
      model: 'fake/model',
      providerId: profile.id,
      providerKind: 'gateway'
    })
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)

    const session = db('sessions').get('s1')
    expect(session?.title).toBe('crie nota.txt')
    expect(session?.status).toBe('idle')
    expect(session?.hangarSessionId).toBeTruthy()
    // The harness talks to <base>/v1/chat/completions with the profile's secret, which never reaches the transcript.
    expect(fake.requests[0].path).toBe('/v1/chat/completions')
    expect(fake.requests[0].auth).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(list)).not.toContain(SECRET)
  })

  it(
    '"Aceitar edições" stops asking for writes; a denied command tells the model why',
    { timeout: 90_000 },
    async () => {
      const before = (await results()).length
      fake.script = [
        { tool: 'write', args: { path: 'b.txt', content: 'b' } },
        { tool: 'shell', args: { command: 'echo perigo' } },
        { text: 'Parei.' },
        { text: 'Parei mesmo.' }
      ]
      const runner = registry.runnerFor('s1')
      await runner.setOptions({ permissionMode: 'acceptEdits' })
      await runner.send('escreva b.txt e rode um comando')
      const pending = await until('the shell permission', () => runner.state().pending[0])
      expect(pending.toolName).toBe('Bash')
      expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('b')
      runner.respond(pending.requestId, { decision: 'deny', message: 'nao rode isso' })
      await until('the second result', async () => (await results())[before])
      const denied = byKind(await entries(), 'tool_result').find((e) => e.isError)
      expect(denied?.content).toContain('nao rode isso')
      // Same process, same conversation: the model saw the first turn too.
      const last = fake.requests[fake.requests.length - 1].body.messages
      expect(last.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(2)
    }
  )

  it('interrupting stops the stream and leaves the session usable', { timeout: 90_000 }, async () => {
    const before = (await results()).length
    fake.script = [{ text: Array(300).fill('palavra').join(' '), delayMs: 40 }, { text: 'de volta' }]
    const runner = registry.runnerFor('s1')
    await runner.send('fale muito')
    await until('streamed text', () => runner.state().streamText || undefined)
    const t0 = Date.now()
    await runner.interrupt()
    const result = await until('the interrupted result', async () => (await results())[before])
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(result).toMatchObject({ subtype: 'interrupted', isError: false })
    expect((await entries()).some((e) => e.kind === 'system' && e.text === 'Interrompido pelo usuário.')).toBe(true)
    await runner.send('e agora?')
    await until('the turn after the interrupt', async () => (await results())[before + 1])
    expect(db('sessions').get('s1')?.status).toBe('idle')
  })

  it('after the process is closed, the next message resumes the same conversation', { timeout: 90_000 }, async () => {
    const before = (await results()).length
    const id = db('sessions').get('s1')?.hangarSessionId
    registry.closeRunner('s1')
    await new Promise((r) => setTimeout(r, 1500))
    fake.script = [{ text: 'continuando' }]
    await registry.runnerFor('s1').send('continue de onde parou')
    await until('the resumed result', async () => (await results())[before])
    expect(db('sessions').get('s1')?.hangarSessionId).toBe(id)
    const messages = fake.requests[fake.requests.length - 1].body.messages
    expect(JSON.stringify(messages)).toContain('crie nota.txt')
  })

  it('rewind and fork are refused clearly; there are no slash commands', async () => {
    const { rewind, rewindPreview } = await import('../../src/main/features/engine/branch')
    const user = byKind(await entries(), 'user')[0]
    expect((await rewindPreview('s1', user.id)).canRewindConversation).toBe(false)
    await expect(rewind('s1', user.id)).rejects.toThrow(/motor Hangar/)
    expect(await registry.slashCommandsFor('s1')).toEqual([])
  })
})
