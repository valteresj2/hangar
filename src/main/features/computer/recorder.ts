// "Gravar uma tarefa" — main process: the recording session (the helper watches the chosen apps; the window records
// the microphone), the red indicator with Pausar/Parar, the review, and the trips to the platform (transcription,
// draft, hiring). Nothing leaves this computer before the person presses "Enviar". Design:
// docs/platform/record-to-agent-plan.md.
import { app, BrowserWindow, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { AllowedApp } from '../../../shared/features/computer'
import {
  RECORDER,
  type HireInput,
  type RecorderState,
  type RecordingDetail,
  type RecordingDraft,
  type RecordingPatch,
  type StartRecording,
  type TranscriptSegment
} from '../../../shared/features/recorder'
import { broadcast } from '../../core/broadcast'
import { platformLogin, platformSend } from '../platform/api'
import { str } from './agui'
import { screenDriver, screenInUse, shareForRecording } from './controller'
import type { ComputerDriver } from './driver/types'
import { blockedReason } from './guard'
import { RecordingIndicator } from './overlay'
import {
  buildPackage,
  draftProblems,
  normalizeDraft,
  RECORDING_LIMIT_MS,
  RecordingStore,
  RETENTION_DAYS,
  summary,
  tidy,
  toSteps,
  type RecordingMeta
} from './recording'

const POLL_MS = 600
const MAX_AUDIO = 40 * 1024 * 1024

const root = (): string => join(app.getPath('userData'), 'recordings')

let keyCache: Buffer | undefined
/** The recordings' key: random, kept encrypted by the system (safeStorage: DPAPI, Keychain, libsecret). */
async function key(): Promise<Buffer> {
  if (keyCache) return keyCache
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error('A criptografia do sistema não está disponível: a gravação não pode ser guardada com segurança.')
  const f = join(root(), 'key.bin')
  mkdirSync(root(), { recursive: true })
  if (existsSync(f)) {
    const { result } = await safeStorage.decryptStringAsync(readFileSync(f))
    keyCache = Buffer.from(result, 'base64')
  } else {
    const k = randomBytes(32)
    writeFileSync(f, await safeStorage.encryptStringAsync(k.toString('base64')))
    keyCache = k
  }
  return keyCache
}

let store: RecordingStore | undefined
const recordings = (): RecordingStore => (store ??= new RecordingStore(root(), key))

interface Session {
  meta: RecordingMeta
  driver: ComputerDriver
  /** Recorded time before the current stretch (pauses do not count). */
  doneMs: number
  /** Start of the current stretch (undefined while paused). */
  since?: number
  microphone: boolean
  timer?: NodeJS.Timeout
  polling: boolean
}

let session: Session | undefined
let indicator: RecordingIndicator | undefined

const fakeMode = (): boolean => process.env.HANGAR_COMPUTER_DRIVER === 'fake'
/** Development only (never in the installed app): also record synthetic input, so a demo can be driven by a tool. */
const injectedToo = (): boolean => !app.isPackaged && process.env.HANGAR_RECORD_INJECTED === '1'

function support(): { ok: boolean; why?: string } {
  if (fakeMode() || process.platform === 'win32') return { ok: true }
  return { ok: false, why: 'Gravar uma tarefa funciona no Windows por enquanto (macOS e Linux virão depois).' }
}

/** Agent Hangar's own windows (the app, the indicators): clicks on them are not part of the task. */
function ownWindows(): number[] {
  const out = indicator?.hwnds() ?? []
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    const b = w.getNativeWindowHandle()
    out.push(b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0))
  }
  return [...new Set(out)]
}

const elapsed = (s: Session): number => s.doneMs + (s.since !== undefined ? Date.now() - s.since : 0)
const clock = (ms: number): string => {
  const t = Math.floor(ms / 1000)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export async function getState(): Promise<RecorderState> {
  const s = support()
  let list: RecordingMeta[] = []
  try {
    list = await recordings().list()
  } catch {
    /* no key yet */
  }
  return {
    supported: s.ok,
    ...(s.why ? { why: s.why } : {}),
    ...(session
      ? {
          active: {
            id: session.meta.id,
            title: session.meta.title,
            paused: session.since === undefined,
            elapsedMs: elapsed(session),
            steps: session.meta.timeline.filter((x) => !x.outside).length,
            microphone: session.microphone,
            apps: session.meta.apps.map((a) => a.name),
            limitMs: RECORDING_LIMIT_MS
          }
        }
      : {}),
    recordings: list.filter((m) => m.id !== session?.meta.id).map(summary),
    retentionDays: RETENTION_DAYS
  }
}

function emit(): void {
  void getState().then((s) => broadcast(RECORDER.evState, s))
  if (session && indicator)
    indicator.show({
      title: session.meta.title,
      paused: session.since === undefined,
      elapsed: clock(elapsed(session)),
      steps: session.meta.timeline.filter((x) => !x.outside).length,
      microphone: session.microphone
    })
}

function cleanApps(apps: AllowedApp[]): AllowedApp[] {
  const seen = new Set<string>()
  return (apps ?? []).filter((a) => {
    const p = str(a?.process).trim()
    if (!p || !str(a?.name).trim() || blockedReason(p) || seen.has(p.toLowerCase())) return false
    seen.add(p.toLowerCase())
    return true
  })
}

/** Reads what the helper watched since the last poll into the recording (captures stored encrypted). */
async function drain(
  s: Session,
  events?: Awaited<ReturnType<NonNullable<ComputerDriver['watchPoll']>>>
): Promise<void> {
  const got = events ?? (s.driver.watchPoll ? await s.driver.watchPoll() : [])
  if (!got.length) return
  const offset = s.doneMs
  const pending: Promise<void>[] = []
  const steps = toSteps(got, s.meta.apps, offset, (png) => {
    const n = s.meta.frames++
    pending.push(recordings().putFrame(s.meta.id, n, png))
    return n
  })
  await Promise.all(pending)
  s.meta.timeline = tidy([...s.meta.timeline, ...steps])
  await recordings().save(s.meta)
}

function tick(s: Session): void {
  s.timer = setInterval(() => {
    if (s.polling || session !== s) return
    s.polling = true
    void drain(s)
      .catch((e) => console.warn('[hangar] gravação:', (e as Error).message))
      .finally(() => {
        s.polling = false
      })
    if (elapsed(s) >= RECORDING_LIMIT_MS) void stop()
    else emit()
  }, POLL_MS)
}

export async function start(input: StartRecording): Promise<RecorderState> {
  const s = support()
  if (!s.ok) throw new Error(s.why)
  if (session) throw new Error('Já existe uma gravação em andamento.')
  const busy = screenInUse()
  if (busy) throw new Error(busy)
  const apps = cleanApps(input.apps)
  if (!apps.length) throw new Error('Escolha pelo menos um app para gravar.')
  const driver = await screenDriver()
  if (!driver.watchStart) throw new Error('Este computador ainda não sabe gravar uma tarefa.')
  indicator ??= new RecordingIndicator({ stop: () => void stop(), pause: () => void togglePause() })
  await indicator.ready().catch(() => undefined)
  const meta = await recordings().create({
    title: str(input.title).trim().slice(0, 120) || 'Tarefa gravada',
    apps,
    recordedOn: `Computador (${hostname()})`
  })
  try {
    await driver.watchStart({
      processes: apps.map((a) => a.process.replace(/\.exe$/i, '')),
      maxWidth: 1366,
      ignoreHwnds: ownWindows(),
      ...(injectedToo() ? { acceptInjected: true } : {})
    })
  } catch (e) {
    recordings().remove(meta.id)
    indicator.dispose()
    throw e
  }
  session = { meta, driver, doneMs: 0, since: Date.now(), microphone: !!input.microphone, polling: false }
  tick(session)
  emit()
  return getState()
}

async function togglePause(): Promise<RecorderState> {
  return session?.since === undefined ? resume() : pause()
}

export async function pause(): Promise<RecorderState> {
  const s = session
  if (!s || s.since === undefined) return getState()
  s.doneMs = elapsed(s)
  s.since = undefined
  const rest = s.driver.watchStop ? await s.driver.watchStop() : []
  await drain(s, rest)
  emit()
  return getState()
}

export async function resume(): Promise<RecorderState> {
  const s = session
  if (!s || s.since !== undefined) return getState()
  await s.driver.watchStart!({
    processes: s.meta.apps.map((a) => a.process.replace(/\.exe$/i, '')),
    maxWidth: 1366,
    ignoreHwnds: ownWindows(),
    ...(injectedToo() ? { acceptInjected: true } : {})
  })
  s.since = Date.now()
  emit()
  return getState()
}

export async function stop(): Promise<RecorderState> {
  const s = session
  if (!s) return getState()
  if (s.timer) clearInterval(s.timer)
  const wasRunning = s.since !== undefined
  s.doneMs = elapsed(s)
  s.since = undefined
  session = undefined
  indicator?.dispose()
  try {
    const rest = wasRunning && s.driver.watchStop ? await s.driver.watchStop() : []
    await drain(s, rest)
  } catch (e) {
    console.warn('[hangar] gravação:', (e as Error).message)
  }
  s.meta.durationMs = s.doneMs
  s.meta.status = 'review'
  await recordings().save(s.meta)
  emit()
  return getState()
}

// ------------------------------------------------------------------ review

async function detail(meta: RecordingMeta): Promise<RecordingDetail> {
  const frames: Record<number, string> = {}
  for (const st of meta.timeline) {
    if (st.frame === undefined) continue
    const png = await recordings().frame(meta.id, st.frame)
    if (png) frames[st.frame] = `data:image/png;base64,${png}`
  }
  return {
    ...summary(meta),
    appList: meta.apps,
    recordedOn: meta.recordedOn,
    timeline: meta.timeline,
    frames,
    notes: meta.notes,
    transcript: meta.transcript,
    ...(meta.platformId !== undefined ? { platformId: meta.platformId } : {}),
    ...(meta.draft ? { draft: meta.draft } : {}),
    ...(meta.error ? { error: meta.error } : {})
  }
}

async function editable(id: string): Promise<RecordingMeta> {
  if (session?.meta.id === id) throw new Error('Pare a gravação antes.')
  return recordings().get(id)
}

export async function get(id: string): Promise<RecordingDetail> {
  return detail(await recordings().get(id))
}

export async function saveAudio(id: string, audio: Uint8Array, mime: string): Promise<RecordingDetail> {
  const meta = await recordings().get(id)
  if (!(audio instanceof Uint8Array) || !audio.byteLength) return detail(meta)
  if (audio.byteLength > MAX_AUDIO) throw new Error('A narração passou do tamanho máximo (40 MB).')
  await recordings().putAudio(id, Buffer.from(audio))
  meta.audio = { mime: str(mime).slice(0, 60) || 'audio/webm', bytes: audio.byteLength }
  await recordings().save(meta)
  emit()
  return detail(meta)
}

export async function update(id: string, patch: RecordingPatch): Promise<RecordingDetail> {
  const meta = await editable(id)
  if (typeof patch.title === 'string') meta.title = patch.title.trim().slice(0, 120) || meta.title
  if (typeof patch.notes === 'string') meta.notes = patch.notes.slice(0, 20_000)
  if (Array.isArray(patch.removeSteps) && patch.removeSteps.length) {
    const drop = new Set(patch.removeSteps.filter((n) => Number.isInteger(n)))
    for (const [i, st] of meta.timeline.entries())
      if (drop.has(i) && st.frame !== undefined) recordings().dropFrame(id, st.frame)
    meta.timeline = meta.timeline.filter((_s, i) => !drop.has(i))
  }
  if (patch.removeAudio) {
    recordings().dropAudio(id)
    delete meta.audio
    meta.transcript = []
  }
  await recordings().save(meta)
  emit()
  return detail(meta)
}

export async function discard(id: string): Promise<RecorderState> {
  if (session?.meta.id === id) {
    await stop()
  }
  const meta = await recordings()
    .get(id)
    .catch(() => undefined)
  if (meta?.platformId !== undefined && platformLogin())
    await platformSend('DELETE', `/api/app/recordings/${meta.platformId}`).catch(() => undefined)
  recordings().remove(id)
  emit()
  return getState()
}

// ------------------------------------------------------------------ platform

function needLogin(): void {
  if (!platformLogin()) throw new Error('Conecte o app à plataforma (Configurações → Plataforma) antes.')
}

export async function transcribe(id: string): Promise<RecordingDetail> {
  needLogin()
  const meta = await editable(id)
  const audio = await recordings().audio(id)
  if (!audio || !meta.audio) throw new Error('Esta gravação não tem narração.')
  const r = await platformSend<{ segments?: TranscriptSegment[]; text?: string }>(
    'POST',
    '/api/app/recordings/transcribe',
    { audio: audio.toString('base64'), mime: meta.audio.mime },
    { timeoutMs: 300_000 }
  )
  const segs = Array.isArray(r.segments)
    ? r.segments
        .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: str(s.text).trim() }))
        .filter((s) => s.text)
    : []
  meta.transcript = segs.length ? segs : r.text ? [{ start: 0, end: meta.durationMs / 1000, text: str(r.text) }] : []
  await recordings().save(meta)
  return detail(meta)
}

export async function send(id: string): Promise<RecordingDetail> {
  needLogin()
  const meta = await editable(id)
  if (!meta.timeline.some((s) => !s.outside)) throw new Error('A gravação não tem nenhum passo nos apps escolhidos.')
  if (!meta.transcript.length && !meta.notes.trim())
    throw new Error('Explique a tarefa: transcreva a narração ou escreva o que você faz e quando.')
  const frames: Record<number, string> = {}
  for (const s of meta.timeline)
    if (s.frame !== undefined) {
      const png = await recordings().frame(id, s.frame)
      if (png) frames[s.frame] = png
    }
  meta.status = 'sending'
  delete meta.error
  await recordings().save(meta)
  emit()
  try {
    const body = buildPackage(meta, (n) => frames[n])
    const r = await platformSend<{ id: number; status: string; draft?: unknown; error?: string }>(
      'POST',
      meta.platformId !== undefined ? `/api/app/recordings/${meta.platformId}/redraft` : '/api/app/recordings',
      body,
      { timeoutMs: 300_000 }
    )
    meta.platformId = r.id
    if (r.status === 'drafted' && r.draft) {
      meta.draft = normalizeDraft(r.draft)
      meta.status = 'drafted'
    } else {
      meta.status = 'failed'
      meta.error = r.error || 'A plataforma não conseguiu montar o rascunho.'
    }
  } catch (e) {
    meta.status = 'failed'
    meta.error = (e as Error).message
  }
  await recordings().save(meta)
  emit()
  return detail(meta)
}

export async function saveDraft(id: string, draft: RecordingDraft): Promise<RecordingDetail> {
  const meta = await editable(id)
  meta.draft = normalizeDraft(draft)
  if (meta.platformId !== undefined && platformLogin())
    await platformSend('PUT', `/api/app/recordings/${meta.platformId}/draft`, { draft: meta.draft })
  await recordings().save(meta)
  return detail(meta)
}

export async function hire(id: string, input: HireInput): Promise<RecordingDetail> {
  needLogin()
  const meta = await editable(id)
  if (meta.platformId === undefined) throw new Error('Envie a gravação para a plataforma antes.')
  const draft = normalizeDraft(input.draft)
  const problems = draftProblems(draft)
  if (problems.length) throw new Error(problems.join(' '))
  const workstation = input.shareComputer ? await shareForRecording(meta.apps) : undefined
  const r = await platformSend<{ employee?: { slug?: string; name?: string } }>(
    'POST',
    `/api/app/recordings/${meta.platformId}/hire`,
    { draft, ...(workstation !== undefined ? { workstation_id: workstation } : {}) },
    { timeoutMs: 120_000 }
  )
  meta.draft = draft
  if (r.employee?.slug) meta.employee = { slug: r.employee.slug, name: r.employee.name || r.employee.slug }
  meta.status = 'hired'
  await recordings().save(meta)
  emit()
  return detail(meta)
}

// ------------------------------------------------------------------ life

export function startRecorder(): void {
  if (!support().ok) return
  try {
    for (const id of recordings().purge())
      console.info(`[hangar] gravação ${id} apagada (prazo de ${RETENTION_DAYS} dias)`)
  } catch {
    /* nothing recorded yet */
  }
}

export async function disposeRecorder(): Promise<void> {
  if (session) await stop().catch(() => undefined)
  indicator?.dispose()
}
