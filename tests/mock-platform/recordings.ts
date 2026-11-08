// The platform side of "Gravar uma tarefa" for the e2e: the transcription (no speech model here: refused), the package
// that becomes a draft (a fixed draft back, with one question), the person's edits and the hiring.
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MockRecordings {
  packages: Record<string, unknown>[]
  drafts: Record<string, unknown>[]
  hires: Record<string, unknown>[]
  deleted: number[]
  routes(req: IncomingMessage, res: ServerResponse, ctx: { path: string; appAuth(): boolean }): Promise<boolean>
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

const json = (res: ServerResponse, status: number, b: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(b))
  return true
}

export const MOCK_DRAFT = {
  title: 'Lançador de notas',
  mission: 'Escrever o resumo da semana no Bloco de Notas toda segunda.',
  summary: 'Toda segunda às 9h escrevo o resumo e salvo.',
  steps: [
    { app: 'Bloco de Notas', action: 'open', target: 'Bloco de Notas' },
    { app: 'Bloco de Notas', action: 'type', target: 'documento "Texto"', value: 'resumo da semana' },
    { app: 'Bloco de Notas', action: 'click', target: 'button "Salvar"', confirms: true }
  ],
  variables: [{ name: 'resumo', description: 'o texto da semana', source: 'a confirmar' }],
  confirmations: [{ step: 3, description: 'salvar o arquivo' }],
  apps: ['Bloco de Notas'],
  schedule: { cron: '0 9 * * 1', text: 'toda segunda às 9h' },
  questions: [{ question: 'De onde vem o resumo?', answer: '' }],
  secrets: [],
  probation: [
    { title: 'Ensaio 1', description: 'Refaça a tarefa.', expected: 'Salva o resumo com aprovação.' },
    { title: 'Ensaio 2', description: 'Com outros dados.', expected: 'Salva o resumo novo.' },
    { title: 'Ensaio 3', description: 'Imprevisto.', expected: 'Pergunta em vez de adivinhar.' }
  ]
}

export function mockRecordings(): MockRecordings {
  const m: MockRecordings = {
    packages: [],
    drafts: [],
    hires: [],
    deleted: [],
    async routes(req, res, { path, appAuth }) {
      if (!path.startsWith('/api/app/recordings')) return false
      if (!appAuth()) return true
      if (path === '/api/app/recordings/transcribe' && req.method === 'POST') {
        await body(req)
        return json(res, 400, { detail: 'a empresa não tem um modelo de fala (stt) numa conexão de LLM' })
      }
      if (path === '/api/app/recordings' && req.method === 'POST') {
        m.packages.push(await body(req))
        return json(res, 200, { id: 51, status: 'drafted', draft: MOCK_DRAFT, model: 'vision-mock' })
      }
      if (path === '/api/app/recordings/51/draft' && req.method === 'PUT') {
        const b = await body(req)
        m.drafts.push(b)
        return json(res, 200, { id: 51, status: 'drafted', draft: b.draft })
      }
      if (path === '/api/app/recordings/51/hire' && req.method === 'POST') {
        m.hires.push(await body(req))
        return json(res, 200, {
          id: 51,
          status: 'hired',
          employee: { slug: 'lancador-de-notas', name: 'Lançador de notas' },
          probation_started: true
        })
      }
      if (path === '/api/app/recordings/51' && req.method === 'DELETE') {
        m.deleted.push(51)
        return json(res, 200, { deleted: 51 })
      }
      return json(res, 404, { detail: 'Not Found' })
    }
  }
  return m
}
