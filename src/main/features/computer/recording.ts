// "Gravar uma tarefa", the parts without Electron: turning what the helper watched into the steps of the recording,
// the encrypted store on this computer (<userData>/recordings/<id>/: meta, captures and the narration, each one
// AES-256-GCM with a key kept by safeStorage) and the package sent to the platform for the draft.
// Design: docs/platform/record-to-agent-plan.md.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AllowedApp } from '../../../shared/features/computer'
import {
  describeStep,
  type RecordedStep,
  type RecordingDraft,
  type RecordingStatus,
  type RecordingSummary,
  type TranscriptSegment
} from '../../../shared/features/recorder'
import type { WatchEvent } from './driver/types'

export const RECORDING_LIMIT_MS = 30 * 60_000
export const RETENTION_DAYS = 30
/** Captures sent with the package (the steps' own; the whole video never leaves the computer). */
export const MAX_FRAMES_SENT = 12

export interface RecordingMeta {
  id: string
  title: string
  createdAt: number
  durationMs: number
  status: RecordingStatus
  apps: AllowedApp[]
  recordedOn: string
  timeline: RecordedStep[]
  frames: number
  notes: string
  transcript: TranscriptSegment[]
  audio?: { mime: string; bytes: number }
  platformId?: number
  draft?: RecordingDraft
  error?: string
  employee?: { slug: string; name: string }
}

// ------------------------------------------------------------------ steps

const appOf = (apps: AllowedApp[], process: string | undefined): string | undefined => {
  const p = (process ?? '').toLowerCase()
  return apps.find((a) => a.process.toLowerCase().replace(/\.exe$/, '') === p)?.name ?? (process || undefined)
}

const combo = (key: string, modifiers: string[] = []): string => [...modifiers, key].join('+')

/**
 * What the helper reported → steps of the recording. A capture is stored apart (`frame` is its index, assigned by
 * saveFrame). Typing in the same field is one step with the final value; a password never has a value; anything in
 * another app is only "outside".
 */
export function toSteps(
  events: WatchEvent[],
  apps: AllowedApp[],
  offsetMs: number,
  saveFrame: (png: string) => number | undefined
): RecordedStep[] {
  const out: RecordedStep[] = []
  for (const e of events) {
    const t = Math.max(0, Math.round(offsetMs + (e.t ?? 0)))
    if (e.outside) {
      out.push({ t, kind: e.kind === 'window' ? 'window' : 'click', outside: true })
      continue
    }
    const app = appOf(apps, e.process)
    const base = { t, ...(app ? { app } : {}), ...(e.window ? { window: e.window } : {}) }
    if (e.kind === 'click') {
      const frame = e.frame ? saveFrame(e.frame) : undefined
      out.push({
        ...base,
        kind: 'click',
        button: e.button === 'right' ? 'right' : 'left',
        ...(e.element ? { element: { name: e.element.name ?? '', type: e.element.type ?? '' } } : {}),
        ...(frame !== undefined ? { frame } : {})
      })
    } else if (e.kind === 'type') {
      out.push({
        ...base,
        kind: 'type',
        field: e.field ?? '',
        ...(e.password ? { password: true } : { value: e.value ?? '' })
      })
    } else if (e.kind === 'key') {
      out.push({ ...base, kind: 'key', key: combo(e.key ?? '', e.modifiers) })
    } else if (e.kind === 'window') {
      out.push({ ...base, kind: 'window' })
    }
  }
  return out
}

/** Consecutive window steps of the same window, and repeated "outside" steps, say nothing new. */
export function tidy(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = []
  for (const s of steps) {
    const prev = out[out.length - 1]
    if (prev && s.kind === 'window' && prev.kind === 'window' && prev.window === s.window && prev.outside === s.outside)
      continue
    if (prev && s.outside && prev.outside && prev.kind === s.kind) continue
    out.push(s)
  }
  return out
}

/** The captures to send: the clicks', evenly spread when there are more than the limit. */
export function framesToSend(steps: RecordedStep[], max = MAX_FRAMES_SENT): number[] {
  const all = steps.filter((s) => s.frame !== undefined).map((s) => s.frame!)
  if (all.length <= max) return all
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(all[Math.round((i * (all.length - 1)) / (max - 1))])
  return [...new Set(out)]
}

/** The package the platform turns into a draft (POST /api/app/recordings). */
export function buildPackage(meta: RecordingMeta, frame: (n: number) => string | undefined): Record<string, unknown> {
  const sent = framesToSend(meta.timeline)
  return {
    title: meta.title,
    recorded_on: meta.recordedOn,
    duration_s: Math.round(meta.durationMs / 1000),
    apps: meta.apps.map((a) => ({ name: a.name, process: a.process })),
    notes: meta.notes,
    transcript: meta.transcript,
    steps: meta.timeline.map((s, i) => ({ i, ...s, text: describeStep(s) })),
    frames: sent
      .map((n) => ({ frame: n, step: meta.timeline.findIndex((s) => s.frame === n), png: frame(n) }))
      .filter((f) => !!f.png)
  }
}

export function summary(m: RecordingMeta): RecordingSummary {
  return {
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    durationMs: m.durationMs,
    status: m.status,
    steps: m.timeline.filter((s) => !s.outside).length,
    audio: !!m.audio,
    apps: m.apps.map((a) => a.name),
    ...(m.employee ? { employee: m.employee } : {})
  }
}

// ------------------------------------------------------------------ store

const ID = /^[0-9a-f-]{36}$/

/** Everything of the recordings, encrypted on disk (the key comes from safeStorage: see recorder.ts). */
export class RecordingStore {
  constructor(
    readonly root: string,
    private readonly key: () => Promise<Buffer>
  ) {}

  private dir(id: string): string {
    if (!ID.test(id)) throw new Error('Gravação inválida.')
    return join(this.root, id)
  }

  private async seal(file: string, data: Buffer): Promise<void> {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', await this.key(), iv)
    const body = Buffer.concat([c.update(data), c.final()])
    writeFileSync(file, Buffer.concat([iv, c.getAuthTag(), body]))
  }

  private async open(file: string): Promise<Buffer> {
    const raw = readFileSync(file)
    const d = createDecipheriv('aes-256-gcm', await this.key(), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()])
  }

  async create(init: Pick<RecordingMeta, 'title' | 'apps' | 'recordedOn'>): Promise<RecordingMeta> {
    const meta: RecordingMeta = {
      id: randomUUID(),
      createdAt: Date.now(),
      durationMs: 0,
      status: 'recording',
      timeline: [],
      frames: 0,
      notes: '',
      transcript: [],
      ...init
    }
    mkdirSync(this.dir(meta.id), { recursive: true })
    await this.save(meta)
    return meta
  }

  async save(meta: RecordingMeta): Promise<void> {
    await this.seal(join(this.dir(meta.id), 'meta.bin'), Buffer.from(JSON.stringify(meta), 'utf8'))
  }

  async get(id: string): Promise<RecordingMeta> {
    const f = join(this.dir(id), 'meta.bin')
    if (!existsSync(f)) throw new Error('Esta gravação não existe mais.')
    return JSON.parse((await this.open(f)).toString('utf8')) as RecordingMeta
  }

  async list(): Promise<RecordingMeta[]> {
    if (!existsSync(this.root)) return []
    const out: RecordingMeta[] = []
    for (const id of readdirSync(this.root)) {
      if (!ID.test(id)) continue
      try {
        out.push(await this.get(id))
      } catch {
        /* unreadable (another key, half written): purge() removes it when old */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async putFrame(id: string, n: number, pngB64: string): Promise<void> {
    await this.seal(join(this.dir(id), `frame-${n}.bin`), Buffer.from(pngB64, 'base64'))
  }

  async frame(id: string, n: number): Promise<string | undefined> {
    const f = join(this.dir(id), `frame-${n}.bin`)
    return existsSync(f) ? (await this.open(f)).toString('base64') : undefined
  }

  dropFrame(id: string, n: number): void {
    rmSync(join(this.dir(id), `frame-${n}.bin`), { force: true })
  }

  async putAudio(id: string, data: Buffer): Promise<void> {
    await this.seal(join(this.dir(id), 'audio.bin'), data)
  }

  async audio(id: string): Promise<Buffer | undefined> {
    const f = join(this.dir(id), 'audio.bin')
    return existsSync(f) ? this.open(f) : undefined
  }

  dropAudio(id: string): void {
    rmSync(join(this.dir(id), 'audio.bin'), { force: true })
  }

  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true })
  }

  /** Recordings older than the retention are deleted for real (their folder, captures and narration). */
  purge(days = RETENTION_DAYS, now = Date.now()): string[] {
    if (!existsSync(this.root)) return []
    const gone: string[] = []
    for (const id of readdirSync(this.root)) {
      if (!ID.test(id)) continue
      const d = join(this.root, id)
      try {
        if (now - statSync(d).mtimeMs > days * 86_400_000) {
          rmSync(d, { recursive: true, force: true })
          gone.push(id)
        }
      } catch {
        /* already gone */
      }
    }
    return gone
  }
}

// ------------------------------------------------------------------ draft

const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
const ACTIONS = new Set(['open', 'click', 'type', 'key', 'scroll', 'check', 'wait'])

/** The draft as the platform (or the person, in the review) sent it, in the fixed shape (unknown fields dropped). */
export function normalizeDraft(raw: unknown): RecordingDraft {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const sched = d.schedule && typeof d.schedule === 'object' ? (d.schedule as Record<string, unknown>) : {}
  return {
    title: text(d.title, 120),
    mission: text(d.mission),
    summary: text(d.summary),
    steps: list(d.steps).map((s, i) => {
      const action = text(s.action, 20)
      return {
        n: i + 1,
        app: text(s.app, 120),
        action: (ACTIONS.has(action) ? action : 'check') as RecordingDraft['steps'][number]['action'],
        target: text(s.target, 300),
        ...(text(s.value, 500) ? { value: text(s.value, 500) } : {}),
        ...(s.confirms === true ? { confirms: true } : {}),
        ...(text(s.note, 500) ? { note: text(s.note, 500) } : {})
      }
    }),
    variables: list(d.variables).map((v) => ({
      name: text(v.name, 80),
      description: text(v.description, 500),
      source: text(v.source, 500),
      ...(text(v.example, 200) ? { example: text(v.example, 200) } : {})
    })),
    confirmations: list(d.confirmations).map((c) => ({
      step: Number.isInteger(c.step) ? (c.step as number) : 0,
      description: text(c.description, 500)
    })),
    apps: Array.isArray(d.apps) ? d.apps.map((a) => text(a, 120)).filter(Boolean) : [],
    schedule: {
      cron: text(sched.cron, 60),
      text: text(sched.text, 200),
      ...(text(sched.timezone, 60) ? { timezone: text(sched.timezone, 60) } : {})
    },
    questions: list(d.questions).map((q) => ({ question: text(q.question, 500), answer: text(q.answer, 1000) })),
    secrets: list(d.secrets).map((s) => ({ name: text(s.name, 80), field: text(s.field, 200) })),
    probation: list(d.probation).map((p) => ({
      title: text(p.title, 200),
      description: text(p.description),
      expected: text(p.expected, 1000)
    }))
  }
}

/** A cron of five fields (minute hour day month weekday), the shape the platform's routines use. */
export const validCron = (c: string): boolean => /^\S+(\s+\S+){4}$/.test(c.trim())

/** What still blocks hiring from a reviewed draft (pt-BR), if anything. */
export function draftProblems(d: RecordingDraft): string[] {
  const out: string[] = []
  if (!d.title) out.push('Dê um nome ao cargo.')
  if (!d.steps.length) out.push('O procedimento não tem passos.')
  if (!validCron(d.schedule.cron)) out.push('Confirme a agenda (quando a tarefa roda).')
  const open = d.questions.filter((q) => q.question && !q.answer).length
  if (open) out.push(open === 1 ? 'Responda a pergunta do rascunho.' : `Responda as ${open} perguntas do rascunho.`)
  return out
}
