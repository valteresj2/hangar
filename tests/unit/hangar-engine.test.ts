// The Hangar engine: pure mappings, and a real HangarRunner driving the real Python bridge (resources/harness)
// against a scripted OpenAI-compatible server. No network and no API key; the second part is skipped when the
// machine has no Python 3.11+.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

  it('the turns so far are recorded for the live graph, without secrets or file contents', async () => {
    const { readFlow } = await import('../../src/main/features/engine/hangar/flow')
    const { FlowGraph } = await import('../../src/shared/flow')
    const events = readFlow('s1')
    const types = events.map((e) => e.type)
    for (const t of ['turn', 'llm_start', 'tool_start', 'tool_end', 'permission', 'permission_result', 'turn_end'])
      expect(types).toContain(t)
    expect(types).not.toContain('delta')
    expect(events.find((e) => e.type === 'turn')).toMatchObject({ text: 'crie nota.txt', model: 'fake/model' })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect(events.every((e) => !('output' in e))).toBe(true)
    const graph = new FlowGraph()
    for (const ev of events) graph.on(ev)
    const layout = graph.layout()
    expect(layout.running).toBe(false)
    expect(layout.nodes[0]).toMatchObject({ kind: 'head', title: 'agente principal', sub: 'model' })
    expect(layout.nodes.filter((n) => n.kind === 'user').length).toBeGreaterThanOrEqual(3)
    expect(layout.nodes.some((n) => n.kind === 'tool' && n.title === 'write' && n.status === 'ok')).toBe(true)
    expect(layout.nodes.some((n) => n.kind === 'ask' && n.status === 'ok')).toBe(true)
    expect(layout.nodes.some((n) => n.kind === 'final' && n.title === 'interrompido')).toBe(true)
    expect(layout.nodes.at(-1)).toMatchObject({ kind: 'final', title: 'resultado', status: 'ok' })
    // One result node per turn.
    expect(layout.nodes.filter((n) => n.kind === 'final').length).toBe(
      layout.nodes.filter((n) => n.kind === 'user').length
    )
  })

  it('rewind and fork are refused clearly', async () => {
    const { rewind, rewindPreview } = await import('../../src/main/features/engine/branch')
    const user = byKind(await entries(), 'user')[0]
    expect((await rewindPreview('s1', user.id)).canRewindConversation).toBe(false)
    await expect(rewind('s1', user.id)).rejects.toThrow(/motor Hangar/)
    expect(await registry.slashCommandsFor('s1')).toEqual([])
  })

  it("the project's slash commands are offered and expanded by the harness", { timeout: 90_000 }, async () => {
    mkdirSync(join(work, '.claude', 'commands', 'git'), { recursive: true })
    writeFileSync(
      join(work, '.claude', 'commands', 'resumo.md'),
      '---\ndescription: Resume um arquivo\nargument-hint: <arquivo>\n---\nResuma $ARGUMENTS em 3 linhas.'
    )
    writeFileSync(join(work, '.claude', 'commands', 'git', 'commit.md'), 'Escreva a mensagem de commit.')
    expect(await registry.slashCommandsFor('s1')).toEqual([
      { name: 'git:commit', description: '', argumentHint: undefined },
      { name: 'resumo', description: 'Resume um arquivo', argumentHint: '<arquivo>' }
    ])
    const before = (await results()).length
    fake.script = [{ text: 'resumido' }]
    await registry.runnerFor('s1').send('/resumo nota.txt')
    await until('the command turn', async () => (await results())[before])
    const messages = fake.requests[fake.requests.length - 1].body.messages
    expect(messages[messages.length - 1].content).toBe('Resuma nota.txt em 3 linhas.')
    // What the user typed is what the transcript shows.
    expect(byKind(await entries(), 'user').at(-1)?.text).toBe('/resumo nota.txt')
    // A process started after the files exist reports them itself.
    registry.closeRunner('s1')
    await new Promise((r) => setTimeout(r, 1500))
    const runner = registry.runnerFor('s1')
    await runner.ensureStarted()
    expect(runner.commands.map((c) => c.name).sort()).toEqual(['git:commit', 'resumo'])
    rmSync(join(work, '.claude'), { recursive: true, force: true })
  })

  // ── Headless queries: what the bench, the Lab and the reflector run on this engine ──

  it('a headless query without tools is a single plain completion', { timeout: 60_000 }, async () => {
    const { hangarQuery, engineOfProfile } = await import('../../src/main/features/engine/hangar/headless')
    expect(engineOfProfile(profile.id)).toBe('hangar')
    expect(engineOfProfile('anthropic')).toBe('claude')
    const from = fake.requests.length
    fake.script = [{ text: 'resposta direta' }]
    const r = await hangarQuery({
      cwd: work,
      prompt: 'responda',
      providerId: profile.id,
      permission: 'readonly',
      allowedTools: [],
      system: 'REGRA DO JUIZ'
    })
    expect(r.status).toBe('success')
    expect(r.text.trim()).toBe('resposta direta')
    expect(r.costUsd).toBeGreaterThan(0)
    expect(r.outputTokens).toBeGreaterThan(0)
    expect(r.toolCalls).toBe(0)
    expect(r.secrets).toEqual([SECRET])
    const sent = fake.requests.slice(from)
    expect(sent).toHaveLength(1)
    expect((sent[0].body as { tools?: unknown }).tools).toBeUndefined()
    expect(String(sent[0].body.messages[0].content)).toContain('REGRA DO JUIZ')
    expect(sent[0].auth).toBe(`Bearer ${SECRET}`)
  })

  it('the bench runs a task on the "harness" variant and scores it', { timeout: 120_000 }, async () => {
    const bench = await import('../../src/main/features/bench/run')
    const { loadRun } = await import('../../src/main/features/bench/store')
    const expected = 'Olá, "Hangar"! Caminho: C:\\temp\\saída\\log.txt — 100% {ok}'
    fake.script = [
      { tool: 'read', args: { path: 'nao-existe.txt' } },
      { tool: 'write', args: { path: 'greeting.txt', content: expected } },
      { text: 'Criado.' }
    ]
    const id = bench.startRun({
      providerId: profile.id,
      models: ['fake/model'],
      variants: ['harness'],
      taskIds: ['write-exact'],
      maxTurns: 8
    })
    const run = await until(
      'the bench run',
      () => {
        const r = loadRun(id)
        return r && r.status !== 'running' ? r : undefined
      },
      100_000
    )
    expect(run.status).toBe('done')
    const [result] = run.results
    expect(result.ok, result.reason).toBe(true)
    expect(result.variant).toBe('harness')
    expect(result.toolCalls).toBe(2)
    expect(result.toolErrors).toBe(1)
    expect(result.toolErrorSamples?.[0]).toMatch(/^read: /)
    expect(result.turns).toBeGreaterThanOrEqual(3)
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.compat).toBeUndefined()
    expect(run.scores).toMatchObject([{ model: 'fake/model', variant: 'harness', passed: 1, successRate: 1 }])
  })

  it(
    'Lab on the Hangar engine: the proposer edits only harness/, the selector and the reflector answer',
    {
      timeout: 180_000
    },
    async () => {
      providers.setDefaultProvider(profile.id)
      const { runStage, stageDir } = await import('../../src/main/features/lab/propose')
      const { askClaude } = await import('../../src/main/features/lab/select')
      const { runReflector } = await import('../../src/main/features/harness/reflector')

      const base = { 'CLAUDE.md': '# Regras\n' }
      fake.script = [
        { tool: 'read', args: { path: 'task.md' } },
        {
          tool: 'write',
          args: { path: 'harness/CLAUDE.md', content: '# Regras\nRode os testes antes de terminar.\n' }
        },
        { tool: 'write', args: { path: 'task.md', content: 'tarefa trocada' } },
        { tool: 'write', args: { path: 'harness/src/app.js', content: 'x' } },
        { tool: 'read', args: { path: join(work, 'nota.txt') } },
        { text: '<notes>Adicionei a regra de testes.</notes>' }
      ]
      const out = await runStage({
        roundId: 'r1',
        stageId: 'p1',
        job: 'Improve the harness for this task.',
        task: 'Corrija o bug do carrinho.',
        baseTree: base,
        currentTree: base,
        runs: [],
        candidates: [],
        lessons: [],
        examples: [],
        signal: new AbortController().signal
      })
      expect(out.error).toBeUndefined()
      expect(out.fellBack).toBe(false)
      expect(out.keptBase).toBe(false)
      expect(out.tree).toEqual({ 'CLAUDE.md': '# Regras\nRode os testes antes de terminar.\n' })
      expect(out.notes).toBe('Adicionei a regra de testes.')
      expect(out.costUsd).toBeGreaterThan(0)
      const dir = stageDir('r1', 'p1')
      expect(readFileSync(join(dir, 'task.md'), 'utf8').trim()).toBe('Corrija o bug do carrinho.')
      expect(existsSync(join(dir, 'harness', 'src', 'app.js'))).toBe(false)
      const told = JSON.stringify(fake.requests[fake.requests.length - 1].body.messages)
      expect(told).toContain('Only files under harness/ can be changed.')
      expect(told).toContain('is not on the harness surface')
      expect(told).toContain('outside the working directory')
      const offered = (fake.requests[fake.requests.length - 1].body as { tools?: { function: { name: string } }[] })
        .tools
      expect(offered?.map((t) => t.function.name).sort()).toEqual(['edit', 'glob', 'grep', 'read', 'write'])

      const candidate = { finalAnswer: 'feito', diffStat: '', diffExcerpt: '', diffTruncated: false, errors: [] }
      fake.script = [{ text: '<why>B entrega o que foi pedido.</why>\n\n```choice\nB\n```' }]
      const choice = await askClaude('Corrija o bug.', [
        { ...candidate, anonId: 'A' },
        { ...candidate, anonId: 'B' }
      ])
      expect(choice).toMatchObject({ anonId: 'B', why: 'B entrega o que foi pedido.' })
      expect(choice.costUsd).toBeGreaterThan(0)
      expect((fake.requests[fake.requests.length - 1].body as { tools?: unknown }).tools).toBeUndefined()

      fake.script = [{ text: '<edits>\nnone\n</edits>\n\nNO_ENTRY' }]
      expect(await runReflector('reflita sobre a rodada')).toContain('NO_ENTRY')
      const system = String(fake.requests[fake.requests.length - 1].body.messages[0].content)
      expect(system).toContain('You are the reflector of a harness-improvement loop')
    }
  )
})
