// A fake data folder of the ChatGPT desktop app (~/.codex, pointed at with CODEX_HOME) with the same SQLite tables
// and rollout format, for the "Importar projetos do ChatGPT" tests (unit and e2e).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'

export interface FakeCodex {
  codex: string
  site: string
  api: string
  loose: string
  gone: string
}

/**
 * Projects "Site da loja" (with AGENTS.md; conversation "Landing page" in the history index), "API" (conversation
 * "Corrigir login" only in a zstd rollout, in a subfolder and without a project id), "Antigo" (folder gone) and a
 * loose conversation "Script solto" outside every project. A subagent review and an archived thread are left out.
 */
export function makeFakeCodex(root: string): FakeCodex {
  const codex = join(root, '.codex')
  const work = join(root, 'work')

  const site = join(work, 'site')
  const api = join(work, 'api')
  const loose = join(work, 'loose')
  const gone = join(work, 'gone')
  for (const dir of [codex, site, api, loose]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(site, 'AGENTS.md'), '# Regras do site\n')

  const T0 = Date.UTC(2026, 9, 1, 12)
  const state = new DatabaseSync(join(codex, 'state_5.sqlite'))
  state.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, first_user_message TEXT,
        created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT, project_id TEXT, attached_thread_parent_id TEXT);
    `)
  const project = state.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)')
  const rootOf = state.prepare('INSERT INTO project_roots VALUES (?, 0, ?)')
  project.run('p-site', 'Site da loja', '{}', 0, T0, T0)
  rootOf.run('p-site', site)
  project.run('p-api', 'API', '{}', 1, T0, T0)
  rootOf.run('p-api', api)
  project.run('p-gone', 'Antigo', '{}', 2, T0, T0)
  rootOf.run('p-gone', gone)
  const thread = state.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, created_at_ms,
        updated_at_ms, name, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const s = T0 / 1000
  // In the site project by id, with the Windows extended-length prefix on its folder.
  thread.run('t-landing', '', s, s + 60, 'vscode', `\\\\?\\${site}`, 'Landing page', 0, T0, T0 + 60_000, null, 'p-site')
  // Inside the api folder but with no project id: grouped by folder.
  thread.run(
    't-auth',
    join(codex, 'rollout-auth.jsonl.zst'),
    s,
    s + 30,
    'vscode',
    join(api, 'src'),
    'Corrigir login',
    0,
    T0,
    T0 + 30_000,
    null,
    null
  )
  // Outside every project: its own folder becomes a project.
  thread.run('t-loose', '', s, s + 10, 'vscode', loose, 'Script solto', 0, T0, T0 + 10_000, null, null)
  // Left out: subagent review, archived.
  thread.run(
    't-guard',
    '',
    s,
    s,
    '{"subagent":{"other":"guardian"}}',
    site,
    'Guardian review',
    0,
    T0,
    T0,
    null,
    'p-site'
  )
  thread.run('t-old', '', s, s, 'vscode', site, 'Arquivada', 1, T0, T0, null, 'p-site')
  state.close()

  const history = new DatabaseSync(join(codex, 'thread_history_1.sqlite'))
  history.exec(`CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL)`)
  const item = history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)')
  const items: [string, object][] = [
    ['userMessage', { type: 'userMessage', content: [{ type: 'text', text: 'Crie a landing page da loja' }] }],
    ['agentMessage', { type: 'agentMessage', text: 'Vou olhar o projeto primeiro.', phase: 'commentary' }],
    ['reasoning', { type: 'reasoning' }],
    ['agentMessage', { type: 'agentMessage', text: 'Pronto: index.html criado com a vitrine.', phase: 'final_answer' }]
  ]
  items.forEach(([type, json], i) =>
    item.run('t-landing', 'turn-1', `item-${i}`, i, T0 + i * 1000, JSON.stringify(json), type)
  )
  history.close()

  // t-auth has no history items: its rollout (zstd JSONL) is read instead.
  const rollout = [
    { timestamp: '2026-10-01T12:00:00Z', type: 'session_meta', payload: { id: 't-auth', cwd: api } },
    {
      timestamp: '2026-10-01T12:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<app-context>injetado</app-context>' }]
      }
    },
    {
      timestamp: '2026-10-01T12:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'O login falha com 401' }] }
      }
    },
    {
      timestamp: '2026-10-01T12:00:03Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'O token expirava; corrigi o refresh.' }]
      }
    }
  ]
  writeFileSync(
    join(codex, 'rollout-auth.jsonl.zst'),
    zstdCompressSync(Buffer.from(rollout.map((r) => JSON.stringify(r)).join('\n') + '\n'))
  )
  return { codex, site, api, loose, gone }
}
