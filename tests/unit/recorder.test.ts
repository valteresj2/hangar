// "Gravar uma tarefa" without Electron: what the helper watched becomes the recording's steps (a password never has a
// value, another app is only "outside"), the encrypted store on disk, the package sent for the draft and the draft's
// checks before hiring.
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { describeStep } from '../../src/shared/features/recorder'
import { FakeDriver } from '../../src/main/features/computer/driver/fake'
import type { WatchEvent } from '../../src/main/features/computer/driver/types'
import {
  buildPackage,
  draftProblems,
  framesToSend,
  normalizeDraft,
  RecordingStore,
  tidy,
  toSteps,
  validCron
} from '../../src/main/features/computer/recording'

const APPS = [{ name: 'Mini ERP', process: 'MiniErp' }]
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hangar-rec-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('steps of a recording', () => {
  const events: WatchEvent[] = [
    { t: 10, kind: 'window', window: 'Mini ERP 1.0', process: 'MiniErp' },
    { t: 20, kind: 'window', window: 'Mini ERP 1.0', process: 'MiniErp' },
    {
      t: 100,
      kind: 'click',
      process: 'MiniErp',
      window: 'Mini ERP 1.0',
      element: { name: 'Fatura', type: 'edit' },
      frame: 'PNGDATA'
    },
    { t: 300, kind: 'type', process: 'MiniErp', field: 'Fatura', value: '1234' },
    { t: 400, kind: 'type', process: 'MiniErp', field: 'Senha', password: true, value: 'never' },
    { t: 500, kind: 'click', outside: true },
    { t: 510, kind: 'click', outside: true },
    { t: 600, kind: 'key', process: 'MiniErp', key: 's', modifiers: ['ctrl'] }
  ]

  it('keeps what matters and never the value of a password', () => {
    const frames: string[] = []
    const steps = tidy(
      toSteps(events, APPS, 1000, (png) => {
        frames.push(png)
        return frames.length - 1
      })
    )
    expect(steps.map((s) => s.kind)).toEqual(['window', 'click', 'type', 'type', 'click', 'key'])
    expect(steps[0]).toMatchObject({ t: 1010, app: 'Mini ERP' })
    expect(steps[1]).toMatchObject({ element: { name: 'Fatura', type: 'edit' }, frame: 0 })
    expect(frames).toEqual(['PNGDATA'])
    expect(steps[3]).toEqual({ t: 1400, app: 'Mini ERP', kind: 'type', field: 'Senha', password: true })
    expect(JSON.stringify(steps)).not.toContain('never')
    expect(steps[4]).toEqual({ t: 1500, kind: 'click', outside: true })
    expect(steps[5].key).toBe('ctrl+s')
  })

  it('reads each step as a sentence', () => {
    const steps = toSteps(events, APPS, 0, () => 0)
    expect(describeStep(steps[2])).toBe('clicou em edit "Fatura" em Mini ERP')
    expect(describeStep(steps[3])).toBe('escreveu "1234" no campo "Fatura" em Mini ERP')
    expect(describeStep(steps[4])).toBe('digitou a senha no campo "Senha" em Mini ERP')
    expect(describeStep(steps[5])).toBe('clicou em outro app (não gravado)')
  })

  it('sends at most 12 captures, spread over the recording', () => {
    const steps = Array.from({ length: 30 }, (_v, i) => ({ t: i, kind: 'click' as const, frame: i }))
    const sent = framesToSend(steps)
    expect(sent.length).toBe(12)
    expect(sent[0]).toBe(0)
    expect(sent[sent.length - 1]).toBe(29)
  })
})

describe('the encrypted store', () => {
  const key = randomBytes(32)
  it('keeps everything encrypted and deletes for real', async () => {
    const root = tmp()
    const store = new RecordingStore(root, async () => key)
    const meta = await store.create({ title: 'Faturas secretas', apps: APPS, recordedOn: 'PC' })
    meta.notes = 'toda segunda às 9h'
    await store.save(meta)
    await store.putFrame(meta.id, 0, Buffer.from('frame-bytes').toString('base64'))
    await store.putAudio(meta.id, Buffer.from('audio-bytes'))
    for (const f of readdirSync(join(root, meta.id))) {
      const raw = readFileSync(join(root, meta.id, f)).toString('latin1')
      for (const plain of ['Faturas secretas', 'toda segunda', 'frame-bytes', 'audio-bytes'])
        expect(raw).not.toContain(plain)
    }
    expect((await store.get(meta.id)).notes).toBe('toda segunda às 9h')
    expect(Buffer.from((await store.frame(meta.id, 0))!, 'base64').toString()).toBe('frame-bytes')
    expect((await store.audio(meta.id))!.toString()).toBe('audio-bytes')
    // another key cannot read it
    await expect(new RecordingStore(root, async () => randomBytes(32)).get(meta.id)).rejects.toThrow()
    expect(() => store.remove('../../etc')).toThrow('inválida')
    store.remove(meta.id)
    expect(await store.list()).toEqual([])
  })

  it('purges recordings past the retention', async () => {
    const root = tmp()
    const store = new RecordingStore(root, async () => key)
    const old = await store.create({ title: 'velha', apps: APPS, recordedOn: 'PC' })
    const fresh = await store.create({ title: 'nova', apps: APPS, recordedOn: 'PC' })
    const past = new Date(Date.now() - 40 * 86_400_000)
    utimesSync(join(root, old.id), past, past)
    expect(store.purge(30)).toEqual([old.id])
    expect((await store.list()).map((m) => m.id)).toEqual([fresh.id])
  })
})

describe('package and draft', () => {
  it('builds the package with the captures of the steps', async () => {
    const store = new RecordingStore(tmp(), async () => randomBytes(32))
    const meta = await store.create({ title: 'Faturas', apps: APPS, recordedOn: 'PC' })
    meta.timeline = [
      { t: 0, kind: 'click', app: 'Mini ERP', element: { name: 'Lançar', type: 'button' }, frame: 0 },
      { t: 5, kind: 'type', app: 'Mini ERP', field: 'Senha', password: true }
    ]
    meta.durationMs = 61_000
    const pkg = buildPackage(meta, (n) => (n === 0 ? 'PNG0' : undefined))
    expect(pkg).toMatchObject({ title: 'Faturas', duration_s: 61, frames: [{ frame: 0, step: 0, png: 'PNG0' }] })
    expect((pkg.steps as { text: string }[])[1].text).toContain('digitou a senha')
  })

  it('normalizes the draft and says what blocks hiring', () => {
    const d = normalizeDraft({
      title: 'Lançador',
      steps: [
        { action: 'explode', target: 'x' },
        { action: 'click', target: 'Lançar', confirms: true }
      ],
      schedule: { cron: '0 9 * * 1', text: 'toda segunda' },
      questions: [{ question: 'Para quem vai?', answer: '' }],
      extra: 'ignored'
    })
    expect(d.steps.map((s) => s.action)).toEqual(['check', 'click'])
    expect(d.steps[1].confirms).toBe(true)
    expect('extra' in d).toBe(false)
    expect(draftProblems(d)).toEqual(['Responda a pergunta do rascunho.'])
    expect(draftProblems({ ...d, schedule: { cron: 'segunda', text: '' }, questions: [] })).toEqual([
      'Confirme a agenda (quando a tarefa roda).'
    ])
    expect(validCron('30 8 * * 1-5')).toBe(true)
    expect(validCron('0 9 * *')).toBe(false)
  })
})

describe('the pretend computer watches too', () => {
  it('reports only the watched apps in detail', async () => {
    const d = new FakeDriver()
    d.did({ kind: 'click', process: 'MiniErp' }) // not watching: ignored
    await d.watchStart({ processes: ['MiniErp'], maxWidth: 800, ignoreHwnds: [] })
    d.did({ kind: 'click', process: 'MiniErp', element: { name: 'Lançar', type: 'button' } })
    d.did({ kind: 'click', process: 'chrome', window: 'Banco — saldo' })
    const got = await d.watchStop()
    expect(got.map((e) => [e.kind, e.outside ?? false])).toEqual([
      ['click', false],
      ['click', true]
    ])
    expect(JSON.stringify(got)).not.toContain('Banco')
  })
})
