// The model bench's task suite: small, deterministic coding tasks with an automatic check each.
//
// Every task writes its fixture into an empty folder, gives the model one prompt (pt-BR, like Hangar's users) and is
// checked from the files the model left behind; nothing depends on what the model says. Fixtures are seeded per
// repeat, so every model and variant gets the same data. Checks run Node scripts with Electron's own Node.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BenchTaskInfo } from '../../../shared/features/bench'

export interface CheckResult {
  ok: boolean
  reason?: string
}

export interface BenchTask extends BenchTaskInfo {
  /** Writes the fixture; returns what the check needs. */
  setup(dir: string, rand: () => number): Record<string, unknown>
  prompt(ctx: Record<string, unknown>): string
  check(dir: string, ctx: Record<string, unknown>): CheckResult
}

/** Small seeded PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function write(dir: string, rel: string, content: string): void {
  const file = join(dir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function read(dir: string, rel: string): string | undefined {
  const file = join(dir, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/** Runs a Node script in `dir` with Electron's Node (or plain Node in tests). */
export function runNode(dir: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    return { ok: true, out }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? 'falhou') }
  }
}

const missing = (rel: string): CheckResult => ({ ok: false, reason: `${rel} não foi criado.` })
const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s)

export const TASKS: BenchTask[] = [
  {
    id: 'write-exact',
    title: 'Criar arquivo com conteúdo exato',
    skills: 'Write; escape de aspas, barras e acentos nos argumentos da ferramenta',
    setup: () => ({ expected: 'Olá, "Hangar"! Caminho: C:\\temp\\saída\\log.txt — 100% {ok}' }),
    prompt: (ctx) =>
      `Crie o arquivo greeting.txt nesta pasta contendo exatamente esta única linha (sem aspas externas, sem nada além dela):\n${String(ctx.expected)}`,
    check: (dir, ctx) => {
      const got = read(dir, 'greeting.txt')
      if (got === undefined) return missing('greeting.txt')
      return got.replace(/^\uFEFF/, '').trim() === ctx.expected
        ? { ok: true }
        : { ok: false, reason: `Conteúdo diferente: ${clip(JSON.stringify(got.trim()))}` }
    }
  },
  {
    id: 'edit-config',
    title: 'Editar JSON preservando o resto',
    skills: 'Read antes de Edit; old_string exato',
    setup: (dir) => {
      const config = {
        name: 'billing-service',
        port: 3000,
        debug: true,
        database: { host: 'db.internal', pool: 10 },
        features: ['invoices', 'refunds', 'reports']
      }
      write(dir, 'config.json', `${JSON.stringify(config, null, 2)}\n`)
      return { expected: { ...config, port: 8080, debug: false, database: { ...config.database, pool: 25 } } }
    },
    prompt: () =>
      'No arquivo config.json desta pasta, mude a porta para 8080, desligue o debug e aumente o pool do banco para 25. Não altere mais nada.',
    check: (dir, ctx) => {
      const got = read(dir, 'config.json')
      if (got === undefined) return missing('config.json')
      try {
        return JSON.stringify(JSON.parse(got)) === JSON.stringify(ctx.expected)
          ? { ok: true }
          : { ok: false, reason: `JSON final diferente do esperado: ${clip(JSON.stringify(JSON.parse(got)))}` }
      } catch {
        return { ok: false, reason: 'config.json deixou de ser um JSON válido.' }
      }
    }
  },
  {
    id: 'fix-bug',
    title: 'Corrigir bug guiado por testes',
    skills: 'rodar testes no shell, ler a falha, Edit, rodar de novo',
    setup: (dir) => {
      write(
        dir,
        'stats.js',
        [
          'function sum(values) {',
          '  return values.reduce((acc, v) => acc + v, 0)',
          '}',
          '',
          'function average(values) {',
          '  if (values.length === 0) return 0',
          '  return sum(values) / (values.length - 1)',
          '}',
          '',
          'function median(values) {',
          '  const sorted = [...values].sort()',
          '  const mid = Math.floor(sorted.length / 2)',
          '  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2',
          '}',
          '',
          'module.exports = { sum, average, median }',
          ''
        ].join('\n')
      )
      const test = [
        "const assert = require('node:assert')",
        "const { sum, average, median } = require('./stats')",
        'assert.strictEqual(sum([1, 2, 3]), 6)',
        'assert.strictEqual(average([2, 4, 6]), 4)',
        'assert.strictEqual(average([]), 0)',
        'assert.strictEqual(median([3, 1, 2]), 2)',
        'assert.strictEqual(median([10, 2, 33, 4]), 7)',
        "console.log('ok')",
        ''
      ].join('\n')
      write(dir, 'test.js', test)
      return { test }
    },
    prompt: () =>
      'Os testes em test.js (rode com `node test.js`) estão falhando. Corrija os bugs em stats.js sem alterar test.js e confirme que os testes passam.',
    check: (dir, ctx) => {
      if (read(dir, 'test.js') !== ctx.test) return { ok: false, reason: 'test.js foi alterado.' }
      const r = runNode(dir, ['test.js'])
      return r.ok && r.out.includes('ok') ? { ok: true } : { ok: false, reason: `Testes ainda falham: ${clip(r.out)}` }
    }
  },
  {
    id: 'find-symbol',
    title: 'Localizar definição no projeto',
    skills: 'Grep/Glob em vários arquivos; resposta em arquivo',
    setup: (dir, rand) => {
      const modules = ['billing', 'orders', 'customers', 'reports', 'shipping', 'tax']
      const files: string[] = []
      for (const m of modules) for (const f of ['index.js', 'helpers.js']) files.push(`src/${m}/${f}`)
      const target = files[Math.floor(rand() * files.length)]
      for (const f of files) {
        const body =
          f === target
            ? 'function parseInvoiceTotal(lines) {\n  return lines.reduce((t, l) => t + l.qty * l.price, 0)\n}\nmodule.exports = { parseInvoiceTotal }\n'
            : `// ${f}\nconst { parseInvoiceTotal } = require('../billing')\nfunction run(x) {\n  return parseInvoiceTotal(x) // uses parseInvoiceTotal\n}\nmodule.exports = { run }\n`
        write(dir, f, body)
      }
      return { target }
    },
    prompt: () =>
      'Em qual arquivo deste projeto a função parseInvoiceTotal é DEFINIDA (não apenas usada)? Grave somente o caminho relativo dele, com barras normais (ex.: src/x/y.js), no arquivo answer.txt.',
    check: (dir, ctx) => {
      const got = read(dir, 'answer.txt')
      if (got === undefined) return missing('answer.txt')
      const norm = got.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      return norm === ctx.target
        ? { ok: true }
        : { ok: false, reason: `Respondeu ${clip(norm)}; certo: ${String(ctx.target)}` }
    }
  },
  {
    id: 'run-script',
    title: 'Executar programa e registrar a saída',
    skills: 'shell; não inventar resultado',
    setup: (dir, rand) => {
      const seed = Math.floor(rand() * 1e9)
      write(
        dir,
        'gen.js',
        `const crypto = require('node:crypto')\nconst h = crypto.createHash('sha256').update('hangar-${seed}').digest('hex')\nconsole.log(h.slice(0, 16))\n`
      )
      return { seed }
    },
    prompt: () => 'Execute `node gen.js` nesta pasta e grave exatamente a linha que ele imprime no arquivo result.txt.',
    check: (dir) => {
      const got = read(dir, 'result.txt')
      if (got === undefined) return missing('result.txt')
      const expected = runNode(dir, ['gen.js']).out.trim()
      return got.replace(/^\uFEFF/, '').trim() === expected
        ? { ok: true }
        : { ok: false, reason: `Gravou ${clip(got.trim())}; o programa imprime ${expected}` }
    }
  },
  {
    id: 'count-log',
    title: 'Analisar arquivo grande',
    skills: 'Grep/shell em arquivo de 2 mil linhas; contagem exata',
    setup: (dir, rand) => {
      const codes = ['E10', 'E42', 'E420', 'E7']
      const levels = ['INFO', 'WARN', 'ERROR', 'DEBUG']
      let expected = 0
      const lines: string[] = []
      for (let i = 0; i < 2000; i++) {
        const level = levels[Math.floor(rand() * levels.length)]
        const code = codes[Math.floor(rand() * codes.length)]
        if (level === 'ERROR' && code === 'E42') expected++
        lines.push(
          `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:${String(i % 60).padStart(2, '0')}:00Z ${level} code=${code} req=${i}`
        )
      }
      write(dir, 'app.log', `${lines.join('\n')}\n`)
      return { expected }
    },
    prompt: () =>
      'Quantas linhas do app.log têm nível ERROR com código exatamente E42 (code=E42, não E420)? Grave só o número em count.txt.',
    check: (dir, ctx) => {
      const got = read(dir, 'count.txt')
      if (got === undefined) return missing('count.txt')
      return Number(got.trim()) === ctx.expected
        ? { ok: true }
        : { ok: false, reason: `Contou ${clip(got.trim())}; certo: ${String(ctx.expected)}` }
    }
  },
  {
    id: 'rename-symbol',
    title: 'Renomear função em vários arquivos',
    skills: 'várias edições coordenadas; verificação final',
    setup: (dir) => {
      write(
        dir,
        'users.js',
        "function getUser(id) {\n  return { id, name: 'user-' + id }\n}\nmodule.exports = { getUser }\n"
      )
      write(
        dir,
        'orders.js',
        "const { getUser } = require('./users')\nfunction orderOwner(order) {\n  return getUser(order.userId).name\n}\nmodule.exports = { orderOwner }\n"
      )
      write(
        dir,
        'main.js',
        "const { getUser } = require('./users')\nconst { orderOwner } = require('./orders')\nconsole.log(getUser(7).name, orderOwner({ userId: 3 }))\n"
      )
      return {}
    },
    prompt: () =>
      'Renomeie a função getUser para fetchUser em todo o projeto (definição, exports, imports e chamadas). Depois confirme com `node main.js` que tudo ainda funciona.',
    check: (dir) => {
      for (const f of ['users.js', 'orders.js', 'main.js']) {
        const text = read(dir, f)
        if (text === undefined) return missing(f)
        if (text.includes('getUser')) return { ok: false, reason: `${f} ainda usa getUser.` }
        if (!text.includes('fetchUser')) return { ok: false, reason: `${f} não usa fetchUser.` }
      }
      const r = runNode(dir, ['main.js'])
      return r.ok && r.out.trim() === 'user-7 user-3' ? { ok: true } : { ok: false, reason: `main.js: ${clip(r.out)}` }
    }
  },
  {
    id: 'implement-module',
    title: 'Implementar função a partir de especificação',
    skills: 'Write de código; casos de borda; testar antes de terminar',
    setup: () => ({}),
    prompt: () =>
      [
        'Crie slug.js nesta pasta exportando (module.exports = { slugify }) a função slugify(text) que:',
        '- converte para minúsculas e remove acentos (ex.: "Ação" → "acao");',
        '- troca toda sequência de caracteres que não sejam a-z ou 0-9 por um único hífen;',
        '- remove hífens do início e do fim;',
        '- devolve "" para entrada vazia ou só com símbolos.',
        'Teste a função antes de terminar.'
      ].join('\n'),
    check: (dir) => {
      if (read(dir, 'slug.js') === undefined) return missing('slug.js')
      write(
        dir,
        '.bench-check.js',
        [
          "const assert = require('node:assert')",
          "const { slugify } = require('./slug')",
          "assert.strictEqual(slugify('Olá Mundo'), 'ola-mundo')",
          "assert.strictEqual(slugify('  Ação & Reação!! '), 'acao-reacao')",
          "assert.strictEqual(slugify('--Já é 2026--'), 'ja-e-2026')",
          "assert.strictEqual(slugify('***'), '')",
          "assert.strictEqual(slugify(''), '')",
          "assert.strictEqual(slugify('São_Paulo/SP'), 'sao-paulo-sp')",
          "console.log('ok')"
        ].join('\n')
      )
      const r = runNode(dir, ['.bench-check.js'])
      return r.ok && r.out.includes('ok')
        ? { ok: true }
        : { ok: false, reason: `Casos de teste falharam: ${clip(r.out)}` }
    }
  }
]

export const taskInfo = (t: BenchTask): BenchTaskInfo => ({ id: t.id, title: t.title, skills: t.skills })
