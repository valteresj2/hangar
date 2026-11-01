// Import from the ChatGPT desktop app, against a fake ~/.codex (tests/fake-codex.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeFakeCodex } from '../fake-codex'
import { useTempUserData } from './helpers/electron'

vi.mock('electron', async () => (await import('./helpers/electron')).default)
vi.mock('../../src/main/features/platform/api', () => ({ assertCanCreateSessions: () => {} }))

const userData = useTempUserData()
const root = mkdtempSync(join(tmpdir(), 'hangar-codex-'))
const { codex, site, api, loose, gone } = makeFakeCodex(root)
process.env.CODEX_HOME = codex

const { listChatgpt, importChatgpt, importedContextAppend, AGENTS_MD_INSTRUCTIONS, contextOf } =
  await import('../../src/main/features/sessions/chatgpt')
const { db } = await import('../../src/main/core/store')
const { readTranscript } = await import('../../src/main/features/engine/api')

afterAll(() => {
  userData.cleanup()
  rmSync(root, { recursive: true, force: true })
})

describe('import from the ChatGPT desktop app', () => {
  it('lists projects with their conversations, leaving subagent and archived threads out', () => {
    const scan = listChatgpt()
    expect(scan.found).toBe(true)
    const byName = Object.fromEntries(scan.projects.map((p) => [p.name, p]))
    expect(Object.keys(byName).sort()).toEqual(['API', 'Antigo', 'Site da loja', 'loose'])
    expect(byName['Site da loja']).toMatchObject({
      key: 'p-site',
      cwd: site,
      exists: true,
      agentsMd: true,
      imported: false
    })
    expect(byName['Site da loja'].threads.map((t) => [t.id, t.messages])).toEqual([['t-landing', 3]])
    expect(byName['API'].threads.map((t) => t.id)).toEqual(['t-auth'])
    expect(byName['loose'].key).toMatch(/^cwd:/)
    expect(byName['loose'].cwd).toBe(loose)
    expect(byName['Antigo']).toMatchObject({ exists: false, threads: [] })
    // Most recent activity first.
    expect(scan.projects[0].name).toBe('Site da loja')
  })

  it('imports a conversation with its project, history and context; a second import skips it', () => {
    const res = importChatgpt({ projects: [], threads: ['t-landing'] })
    expect(res).toEqual({ projects: 1, sessions: 1, skipped: 0 })

    const project = db('projects')
      .list()
      .find((p) => p.cwd === site)!
    expect(project).toMatchObject({ name: 'Site da loja', instructions: AGENTS_MD_INSTRUCTIONS })
    const session = db('sessions')
      .list()
      .find((s) => s.imported?.threadId === 't-landing')!
    expect(session).toMatchObject({ title: 'Landing page', cwd: site, projectId: project.id, status: 'idle' })
    expect(session.sdkSessionId).toBeUndefined()
    // Commentary is shown but stays out of the context.
    expect(session.imported!.context).toBe(
      'Pessoa: Crie a landing page da loja\n\nChatGPT: Pronto: index.html criado com a vitrine.'
    )
    expect(importedContextAppend(session)).toContain('<conversa-chatgpt>\nPessoa: Crie a landing page da loja')

    expect(importChatgpt({ projects: ['p-site'], threads: ['t-landing'] })).toEqual({
      projects: 0,
      sessions: 0,
      skipped: 1
    })
    const site2 = listChatgpt().projects.find((p) => p.key === 'p-site')!
    expect(site2.imported).toBe(true)
    expect(site2.threads[0].imported).toBe(true)
  })

  it('shows the imported history in the session', async () => {
    const session = db('sessions')
      .list()
      .find((s) => s.imported?.threadId === 't-landing')!
    const entries = await readTranscript(session.id)
    expect(entries.map((e) => [e.kind, 'text' in e ? e.text : ''])).toEqual([
      ['system', expect.stringContaining('importada do ChatGPT')],
      ['user', 'Crie a landing page da loja'],
      ['assistant', 'Vou olhar o projeto primeiro.'],
      ['assistant', 'Pronto: index.html criado com a vitrine.']
    ])
  })

  it('falls back to the zstd rollout, without the injected context', async () => {
    expect(importChatgpt({ projects: [], threads: ['t-auth'] })).toMatchObject({ projects: 1, sessions: 1 })
    const session = db('sessions')
      .list()
      .find((s) => s.imported?.threadId === 't-auth')!
    expect(session.cwd).toBe(join(api, 'src'))
    expect(db('projects').get(session.projectId!)).toMatchObject({ name: 'API', cwd: api })
    expect(db('projects').get(session.projectId!)?.instructions).toBeUndefined()
    const entries = await readTranscript(session.id)
    expect(entries.slice(1).map((e) => ('text' in e ? e.text : ''))).toEqual([
      'O login falha com 401',
      'O token expirava; corrigi o refresh.'
    ])
  })

  it('imports a project alone, and skips one whose folder is gone', () => {
    expect(
      importChatgpt({ projects: [listChatgpt().projects.find((p) => p.name === 'loose')!.key], threads: [] })
    ).toEqual({
      projects: 1,
      sessions: 0,
      skipped: 0
    })
    expect(importChatgpt({ projects: ['p-gone'], threads: [] })).toEqual({ projects: 0, sessions: 0, skipped: 1 })
    expect(
      db('projects')
        .list()
        .some((p) => p.cwd === gone)
    ).toBe(false)
  })

  it('keeps the latest part of a long conversation as context', () => {
    const long: Parameters<typeof contextOf>[0] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `${i} ${'x'.repeat(500)}`,
      ts: i
    }))
    const ctx = contextOf(long)
    expect(ctx.startsWith('[início da conversa omitido]')).toBe(true)
    expect(ctx.length).toBeLessThanOrEqual(12_100)
    expect(ctx).toContain(`ChatGPT: 39 `)
  })

  it('says when the ChatGPT app is not on this computer', () => {
    process.env.CODEX_HOME = join(root, 'nowhere')
    try {
      expect(listChatgpt()).toMatchObject({ found: false, projects: [] })
    } finally {
      process.env.CODEX_HOME = codex
    }
  })
})
