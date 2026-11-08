// The computer workstation on this machine, in one of two modes the person turns on explicitly (off by default):
//  - worker: one employee the person manages works here (this computer is its worker: worker.ts);
//  - shared: the platform's employees borrow this computer when they need a screen step (shared.ts); the person
//    chooses who may borrow it and whether each loan asks first.
// The apps allowed here, the tokens (encrypted with safeStorage/DPAPI), the life of the loop (start, kill switch,
// resume) and the state the panel and the indicator show.
//
// Files in <userData>/computer: config.json (employee or sharing, apps, pause), token.json (encrypted ewk_ token of
// the worker mode), share-token.json (encrypted wst_ token of the shared mode),
// task-<id>.json (the conversation of a task in progress), audit.jsonl (local record of the actions, no screenshots
// nor secrets) and the compiled Windows helper.
import { app, dialog, globalShortcut, Notification, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, release } from 'node:os'
import { join } from 'node:path'
import {
  COMPUTER,
  type AllowedApp,
  type ComputerAction,
  type ComputerState,
  type EnableInput,
  type InstalledApp,
  type LeaseInfo,
  type ManagedEmployee,
  type ShareInput,
  type TeamOption
} from '../../../shared/features/computer'
import { broadcast } from '../../core/broadcast'
import { onPlatformState, platformGet, platformLogin, platformSend, platformUrl } from '../platform/api'
import { str, WorkerClient } from './agui'
import { findApps } from './apps'
import { FakeDriver, fakeWindow } from './driver/fake'
import type { ComputerDriver } from './driver/types'
import { createDriver, currentOs, driverNotice, osLabel } from './driver'
import { blockedReason, warningFor } from './guard'
import { Indicator } from './overlay'
import { Presence } from './presence'
import { SharedMachine, WorkstationClient } from './shared'
import { Worker, type WorkerStatus } from './worker'

/** The kill switch, from anywhere. On a Mac (most keyboards have no End key) it is Ctrl+Option+Esc. */
export const STOP_SHORTCUT = process.platform === 'darwin' ? 'Control+Alt+Escape' : 'Control+Alt+End'
const STOP_LABEL = process.platform === 'darwin' ? 'Ctrl+Option+Esc' : 'Ctrl+Alt+End'

interface Config {
  slug?: string
  name?: string
  /** The platform the worker token belongs to. */
  base?: string
  apps: AllowedApp[]
  resumeAfterS: number
  /** Kill switch pressed: stays off until the person resumes. */
  stopped?: boolean
  /** Shared mode: the platform's id of this computer and how it is shared. */
  share?: {
    id: number
    name: string
    base: string
    authMode: 'ask' | 'preauthorized'
    allowManaged: boolean
    teamIds: number[]
  }
}

const dir = (): string => join(app.getPath('userData'), 'computer')
const configFile = (): string => join(dir(), 'config.json')
const tokenFile = (): string => join(dir(), 'token.json')
const shareTokenFile = (): string => join(dir(), 'share-token.json')

let config: Config = { apps: [], resumeAfterS: 15 }
let driver: ComputerDriver | undefined
let worker: Worker | undefined
let indicator: Indicator | undefined
let presence = new Presence(15_000)
let status: WorkerStatus = { status: 'idle' }
let recent: ComputerAction[] = []
let lastError: string | undefined
let unsubscribe: (() => void) | undefined
let machine: SharedMachine | undefined
let shared: { active: LeaseInfo | null; requests: LeaseInfo[]; paused: boolean; detail?: string } = {
  active: null,
  requests: [],
  paused: false
}

const fakeMode = (): boolean => process.env.HANGAR_COMPUTER_DRIVER === 'fake'

function supported(): { ok: boolean; why?: string } {
  if (fakeMode()) return { ok: true }
  if (!currentOs())
    return {
      ok: false,
      why: `O posto no computador funciona no Windows, no macOS e no Linux (não em ${process.platform}).`
    }
  return { ok: true }
}

function readConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<Config>
    return {
      ...c,
      apps: Array.isArray(c.apps) ? c.apps.filter((a) => a && a.name && a.process && !blockedReason(a.process)) : [],
      resumeAfterS: clampResume(c.resumeAfterS ?? 15)
    }
  } catch {
    return { apps: [], resumeAfterS: 15 }
  }
}

function writeConfig(): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(config, null, 2))
}

const clampResume = (s: number): number => Math.max(1, Math.min(Math.round(Number(s) || 15), 600))

async function saveToken(token: string, file = tokenFile()): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error(
      'A criptografia do sistema (safeStorage/DPAPI) não está disponível: o posto não pode guardar o token.'
    )
  mkdirSync(dir(), { recursive: true })
  const data = (await safeStorage.encryptStringAsync(token)).toString('base64')
  writeFileSync(file, JSON.stringify({ data }))
}

async function loadToken(file = tokenFile()): Promise<string | undefined> {
  try {
    const { data } = JSON.parse(readFileSync(file, 'utf8')) as { data: string }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return undefined
    return (await safeStorage.decryptStringAsync(Buffer.from(data, 'base64'))).result
  } catch {
    return undefined
  }
}

function getDriver(): ComputerDriver {
  if (driver) return driver
  if (fakeMode()) {
    // The e2e drives this pretend computer through globalThis.__hangarComputerFake.
    const notes = fakeWindow({ hwnd: 7, title: 'Sem título - Bloco de Notas', process: 'notepad' })
    const fake = new FakeDriver({ windows: [notes], foreground: 7 })
    fake.elementsOf.set(7, [
      { name: 'Texto', type: 'document', password: false, x: 120, y: 160, width: 700, height: 400, value: '' },
      { name: 'Salvar', type: 'button', password: false, x: 820, y: 120, width: 60, height: 24, value: '' }
    ])
    ;(globalThis as Record<string, unknown>).__hangarComputerFake = fake
    driver = fake
  } else {
    driver = createDriver(currentOs()!, dir(), (target) => shell.openPath(target))
  }
  return driver
}

function mode(): ComputerState['mode'] {
  return config.slug ? 'worker' : config.share ? 'shared' : 'off'
}

function sharedStatus(): ComputerState['status'] {
  if (config.stopped) return 'stopped'
  if (lastError) return 'error'
  if (shared.active) return shared.paused ? 'paused' : 'working'
  return 'idle'
}

export function getState(): ComputerState {
  const s = supported()
  const m = mode()
  if (m === 'shared') return sharedState(s)
  const off = m === 'off'
  const st = off
    ? 'off'
    : config.stopped
      ? 'stopped'
      : lastError && status.status !== 'working'
        ? 'error'
        : status.status
  return {
    supported: s.ok,
    ...(s.why ? { unsupportedReason: s.why } : {}),
    connected: !!platformLogin(),
    status: st,
    ...(config.slug ? { employee: { slug: config.slug, name: config.name ?? config.slug } } : {}),
    apps: config.apps,
    resumeAfterS: config.resumeAfterS,
    ...(status.task && !off && !config.stopped ? { task: status.task } : {}),
    ...(st === 'error'
      ? { detail: lastError }
      : config.stopped
        ? { detail: 'Parado por você. Ligue de novo quando quiser.' }
        : status.detail
          ? { detail: status.detail }
          : {}),
    recent,
    ...(driver && driverNotice(driver) ? { notice: driverNotice(driver) } : {}),
    stopShortcut: STOP_LABEL,
    mode: m,
    requests: []
  }
}

function sharedState(s: { ok: boolean; why?: string }): ComputerState {
  const sh = config.share!
  const st = sharedStatus()
  const a = shared.active
  return {
    supported: s.ok,
    ...(s.why ? { unsupportedReason: s.why } : {}),
    connected: !!platformLogin(),
    status: st,
    ...(a
      ? { employee: { slug: a.employee_slug, name: a.employee }, task: { id: a.task_id, title: a.task_title } }
      : {}),
    apps: config.apps,
    resumeAfterS: config.resumeAfterS,
    detail:
      st === 'stopped'
        ? 'Parado por você. Ligue de novo quando quiser.'
        : st === 'error'
          ? lastError
          : st === 'paused'
            ? `Pausado: você está usando o computador. Retomo em ${config.resumeAfterS} s sem uso.`
            : a
              ? `Emprestado a ${a.employee} para a tarefa #${a.task_id}`
              : (shared.detail ?? 'Compartilhado: aguardando pedidos de uso'),
    recent,
    ...(driver && driverNotice(driver) ? { notice: driverNotice(driver) } : {}),
    stopShortcut: STOP_LABEL,
    mode: 'shared',
    share: { id: sh.id, name: sh.name, authMode: sh.authMode, allowManaged: sh.allowManaged, teamIds: sh.teamIds },
    requests: shared.requests,
    ...(a ? { borrower: a } : {})
  }
}

function emit(): void {
  const s = getState()
  broadcast(COMPUTER.evState, s)
  if (!indicator) return
  if ((s.status === 'working' || s.status === 'paused') && s.task && s.employee) {
    indicator.show({
      status: s.status,
      employee: s.employee.name,
      task: `tarefa #${s.task.id}`,
      detail: s.status === 'paused' ? s.detail : undefined,
      shortcut: STOP_LABEL
    })
  } else indicator.hide()
}

function info(): Record<string, string> {
  return {
    name: `Computador (${hostname()})`,
    version: app.getVersion(),
    os: `${osLabel(currentOs())} ${release()}`,
    kind: 'computer',
    apps: config.apps
      .map((a) => a.name)
      .join(', ')
      .slice(0, 120)
  }
}

async function startWorker(): Promise<void> {
  if (worker || !config.slug || config.stopped || !supported().ok) return
  const token = await loadToken()
  if (!token || !config.base) {
    lastError = 'O token do posto não está guardado neste computador: ligue o posto de novo.'
    emit()
    return
  }
  lastError = undefined
  presence = new Presence(config.resumeAfterS * 1000)
  const d = getDriver()
  try {
    await d.start()
  } catch (e) {
    lastError = `Não consegui iniciar o controle do Windows: ${(e as Error).message}`
    emit()
    return
  }
  const w = new Worker({
    client: new WorkerClient(config.base, token),
    driver: d,
    stateDir: dir(),
    apps: () => config.apps,
    selfPid: process.pid,
    ignoreHwnds: () => indicator?.hwnds() ?? [],
    info,
    presence,
    events: {
      status(s) {
        status = s
        if (s.status !== 'error') lastError = undefined
        else lastError = s.detail
        emit()
      },
      action(a) {
        recent = [a, ...recent].slice(0, 30)
        emit()
      },
      target(rect) {
        indicator?.target(rect)
      },
      revoked() {
        worker = undefined
        lastError =
          'O token do posto foi revogado (o funcionário voltou para a plataforma ou foi ligado em outro lugar).'
        emit()
      }
    }
  })
  worker = w
  registerStop()
  status = { status: 'idle', detail: 'Conectando…' }
  emit()
  void w.start().finally(() => {
    if (worker === w) worker = undefined
  })
}

function registerStop(): void {
  if (!globalShortcut.isRegistered(STOP_SHORTCUT)) globalShortcut.register(STOP_SHORTCUT, () => void stop())
}

function askPerson(req: LeaseInfo): void {
  if (fakeMode()) return // the e2e answers in the panel
  const who = `${req.employee} quer usar este computador`
  const detail =
    `Tarefa #${req.task_id}: ${req.task_title}` +
    (req.app ? `\nApp: ${req.app}` : '') +
    (req.reason ? `\nMotivo: ${req.reason}` : '') +
    '\n\nEnquanto ele usa, um aviso fica no alto da tela; você pode parar a qualquer momento.'
  if (Notification.isSupported()) new Notification({ title: 'Agent Hangar', body: who }).show()
  void dialog
    .showMessageBox({
      type: 'question',
      title: 'Agent Hangar — pedido de uso do computador',
      message: who,
      detail,
      buttons: ['Permitir', 'Recusar'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    .then((r) => machine?.answer(req.lease_id, r.response === 0))
    .catch(() => undefined) // already answered in the panel
}

async function startShared(): Promise<void> {
  if (machine || !config.share || config.stopped || !supported().ok) return
  const token = await loadToken(shareTokenFile())
  if (!token) {
    lastError = 'O token deste computador não está guardado aqui: pare de compartilhar e compartilhe de novo.'
    emit()
    return
  }
  lastError = undefined
  presence = new Presence(config.resumeAfterS * 1000)
  const d = getDriver()
  try {
    await d.start()
  } catch (e) {
    lastError = `Não consegui iniciar o controle do computador: ${(e as Error).message}`
    emit()
    return
  }
  const m = new SharedMachine({
    client: new WorkstationClient(config.share.base, token),
    driver: d,
    apps: () => config.apps,
    selfPid: process.pid,
    ignoreHwnds: () => indicator?.hwnds() ?? [],
    presence,
    info,
    waitS: fakeMode() ? 1 : 20,
    events: {
      state(v) {
        shared = v
        lastError = undefined
        emit()
      },
      action(a) {
        recent = [a, ...recent].slice(0, 30)
        emit()
      },
      target(rect) {
        indicator?.target(rect)
      },
      prompt: askPerson,
      revoked() {
        machine = undefined
        lastError = 'A plataforma não reconhece mais este computador (foi desligado no console ou em outro lugar).'
        emit()
      },
      error(detail) {
        lastError = detail
        emit()
      }
    }
  })
  machine = m
  registerStop()
  shared = { active: null, requests: [], paused: false, detail: 'Conectando…' }
  emit()
  void m.start().finally(() => {
    if (machine === m) machine = undefined
  })
}

async function stopShared(): Promise<void> {
  const m = machine
  machine = undefined
  if (globalShortcut.isRegistered(STOP_SHORTCUT)) globalShortcut.unregister(STOP_SHORTCUT)
  indicator?.hide()
  indicator?.target(undefined)
  if (m) await m.stop()
  shared = { active: null, requests: [], paused: false }
}

async function stopWorker(): Promise<void> {
  const w = worker
  worker = undefined
  if (globalShortcut.isRegistered(STOP_SHORTCUT)) globalShortcut.unregister(STOP_SHORTCUT)
  indicator?.hide()
  indicator?.target(undefined)
  if (w) await w.stop()
  status = { status: 'idle' }
}

// ------------------------------------------------------------------ actions (IPC)
export async function managedEmployees(): Promise<ManagedEmployee[]> {
  const all = await platformGet<Record<string, unknown>[]>('/api/employees?mine=1')
  return all
    .filter((e) => e.can_manage !== false && !['offboarded', 'onboarding'].includes(str(e.status)))
    .map((e) => ({
      slug: str(e.slug),
      name: str(e.name) || str(e.slug),
      title: str(e.title),
      status: str(e.status),
      runtime: str(e.runtime) || 'hangar'
    }))
}

export async function installedApps(): Promise<InstalledApp[]> {
  if (!supported().ok) return []
  let windows: Awaited<ReturnType<ComputerDriver['windows']>> = []
  try {
    const d = getDriver()
    await d.start()
    windows = await d.windows()
  } catch {
    /* the picker still lists the Start menu */
  }
  const self = process.pid
  return findApps(
    (p) => {
      try {
        return shell.readShortcutLink(p).target
      } catch {
        return undefined
      }
    },
    windows.filter((w) => w.pid !== self)
  )
}

function cleanApps(apps: AllowedApp[]): AllowedApp[] {
  const seen = new Set<string>()
  const out: AllowedApp[] = []
  for (const a of Array.isArray(apps) ? apps : []) {
    const name = String(a?.name ?? '')
      .trim()
      .slice(0, 80)
    const process = String(a?.process ?? '')
      .trim()
      .replace(/\.exe$/i, '')
      .slice(0, 80)
    if (!name || !process || blockedReason(process) || seen.has(process.toLowerCase())) continue
    seen.add(process.toLowerCase())
    const launch = typeof a.launch === 'string' && a.launch.trim() ? a.launch.trim().slice(0, 500) : undefined
    const warning = warningFor(process)
    out.push({ name, process, ...(launch ? { launch } : {}), ...(warning ? { warning } : {}) })
  }
  return out
}

export async function enable(input: EnableInput): Promise<ComputerState> {
  if (!supported().ok) throw new Error(supported().why)
  const login = platformLogin()
  if (!login) throw new Error('Conecte o app à plataforma (Configurações → Plataforma) para escolher um funcionário.')
  const slug = String(input?.slug ?? '').trim()
  if (!slug) throw new Error('Escolha o funcionário.')
  const apps = cleanApps(input.apps)
  if (!apps.length) throw new Error('Libere pelo menos um app para o funcionário usar neste computador.')
  if (config.share)
    throw new Error(
      'Este computador está compartilhado: pare de compartilhar antes de ligar o posto de um funcionário.'
    )
  const emp = (await managedEmployees()).find((e) => e.slug === slug)
  if (!emp) throw new Error('Você não gerencia esse funcionário (ou ele não está ativo).')
  await stopWorker()
  const r = await platformSend<{ runtime: string; token?: string }>(
    'PUT',
    `/api/employees/${encodeURIComponent(slug)}/runtime`,
    {
      runtime: 'external',
      rotate: true
    }
  )
  if (!r.token) throw new Error('A plataforma não devolveu o token do posto.')
  await saveToken(r.token)
  config = { ...config, slug, name: emp.name, base: platformUrl() || login.url, apps, stopped: false }
  writeConfig()
  recent = []
  await startWorker()
  emit()
  return getState()
}

export async function disable(returnToPlatform: boolean): Promise<ComputerState> {
  const slug = config.slug
  await stopWorker()
  if (returnToPlatform && slug && platformLogin()) {
    await platformSend('PUT', `/api/employees/${encodeURIComponent(slug)}/runtime`, { runtime: 'hangar' })
  }
  rmSync(tokenFile(), { force: true })
  config = { apps: config.apps, resumeAfterS: config.resumeAfterS }
  writeConfig()
  status = { status: 'idle' }
  lastError = undefined
  emit()
  return getState()
}

export async function setApps(apps: AllowedApp[]): Promise<ComputerState> {
  const clean = cleanApps(apps)
  if (config.share) {
    if (!clean.length) throw new Error('Libere pelo menos um app.')
    await platformSend('PATCH', `/api/app/workstations/${config.share.id}`, {
      apps: clean.map((a) => ({ name: a.name, process: a.process }))
    })
  }
  config = { ...config, apps: clean }
  writeConfig()
  emit()
  return getState()
}

export async function teams(): Promise<TeamOption[]> {
  const me = await platformGet<{ user?: { teams?: { id: number; name: string }[] } }>('/api/app/me')
  return (me.user?.teams ?? []).map((t) => ({ id: t.id, name: t.name }))
}

function shareBody(input: Partial<ShareInput>): Record<string, unknown> {
  return {
    ...(input.apps ? { apps: cleanApps(input.apps).map((a) => ({ name: a.name, process: a.process })) } : {}),
    ...(input.authMode ? { auth_mode: input.authMode } : {}),
    ...(input.allowManaged !== undefined ? { allow_managed: !!input.allowManaged } : {}),
    ...(input.teamIds ? { allow_team_ids: input.teamIds.filter((n) => Number.isInteger(n)) } : {})
  }
}

/** Shares this computer with the platform's employees. */
export async function share(input: ShareInput): Promise<ComputerState> {
  if (!supported().ok) throw new Error(supported().why)
  const login = platformLogin()
  if (!login) throw new Error('Conecte o app à plataforma (Configurações → Plataforma) para compartilhar o computador.')
  if (config.slug)
    throw new Error('Este computador é o posto de um funcionário: desligue o posto antes de compartilhar.')
  const apps = cleanApps(input.apps)
  if (!apps.length) throw new Error('Libere pelo menos um app.')
  if (!input.allowManaged && !(input.teamIds ?? []).length)
    throw new Error('Escolha quem pode usar: os funcionários que você gerencia e/ou os de algum time.')
  await stopShared()
  const name = `Computador (${hostname()})`
  const r = await platformSend<{ id: number; name: string; token?: string }>('POST', '/api/app/workstations', {
    name,
    os: `${osLabel(currentOs())} ${release()}`,
    ...shareBody({ ...input, apps })
  })
  if (!r.token) throw new Error('A plataforma não devolveu o token deste computador.')
  await saveToken(r.token, shareTokenFile())
  config = {
    ...config,
    apps,
    stopped: false,
    share: {
      id: r.id,
      name: r.name || name,
      base: platformUrl() || login.url,
      authMode: input.authMode === 'preauthorized' ? 'preauthorized' : 'ask',
      allowManaged: !!input.allowManaged,
      teamIds: input.teamIds ?? []
    }
  }
  writeConfig()
  recent = []
  await startShared()
  emit()
  return getState()
}

export async function updateShare(patch: Partial<ShareInput>): Promise<ComputerState> {
  if (!config.share) throw new Error('Este computador não está compartilhado.')
  await platformSend('PATCH', `/api/app/workstations/${config.share.id}`, shareBody(patch))
  config = {
    ...config,
    ...(patch.apps ? { apps: cleanApps(patch.apps) } : {}),
    share: {
      ...config.share,
      ...(patch.authMode ? { authMode: patch.authMode } : {}),
      ...(patch.allowManaged !== undefined ? { allowManaged: !!patch.allowManaged } : {}),
      ...(patch.teamIds ? { teamIds: patch.teamIds } : {})
    }
  }
  writeConfig()
  emit()
  return getState()
}

export async function unshare(): Promise<ComputerState> {
  const sh = config.share
  await stopShared()
  if (sh && platformLogin()) await platformSend('DELETE', `/api/app/workstations/${sh.id}`).catch(() => undefined)
  rmSync(shareTokenFile(), { force: true })
  config = { apps: config.apps, resumeAfterS: config.resumeAfterS }
  writeConfig()
  lastError = undefined
  emit()
  return getState()
}

export async function answer(leaseId: number, allow: boolean): Promise<ComputerState> {
  if (!machine) throw new Error('Este computador não está compartilhado agora.')
  await machine.answer(leaseId, allow)
  return getState()
}

export function setResumeAfter(s: number): ComputerState {
  config = { ...config, resumeAfterS: clampResume(s) }
  presence.resumeAfterMs = config.resumeAfterS * 1000
  writeConfig()
  emit()
  return getState()
}

/** Kill switch. */
export async function stop(): Promise<ComputerState> {
  if (!config.slug && !config.share) return getState()
  config = { ...config, stopped: true }
  writeConfig()
  if (config.share) await stopShared()
  else await stopWorker()
  emit()
  return getState()
}

export async function resume(): Promise<ComputerState> {
  if (!config.slug && !config.share) return getState()
  config = { ...config, stopped: false }
  writeConfig()
  if (config.share) await startShared()
  else await startWorker()
  emit()
  return getState()
}

export function resumeNow(): ComputerState {
  presence.override()
  emit()
  return getState()
}

export async function start(): Promise<void> {
  config = readConfig()
  if (existsSync(dir()) === false) mkdirSync(dir(), { recursive: true })
  indicator = new Indicator({ stop: () => void stop(), resume: () => void resumeNow() })
  unsubscribe = onPlatformState(() => emit())
  if (config.share) await startShared()
  else await startWorker()
  emit()
}

export async function dispose(): Promise<void> {
  unsubscribe?.()
  await stopWorker()
  await stopShared()
  indicator?.dispose()
  indicator = undefined
  driver?.dispose()
  driver = undefined
}

// ------------------------------------------------------------------ for "gravar uma tarefa" (recorder.ts)

/** This computer's driver, started (the recorder watches the screen through the same helper). */
export async function screenDriver(): Promise<ComputerDriver> {
  const d = getDriver()
  await d.start()
  return d
}

/** Why the screen cannot be recorded now (an employee is using it), if so. */
export function screenInUse(): string | undefined {
  if (mode() === 'worker' && status.status === 'working')
    return `${config.name ?? 'O funcionário'} está usando este computador agora. Pare ou espere terminar para gravar.`
  if (mode() === 'shared' && shared.active)
    return `${shared.active.employee} está usando este computador agora. Espere terminar para gravar.`
  return undefined
}

/**
 * Makes sure this computer is shared with the apps of a recording, asking at each loan (the employee hired from it
 * rehearses and works here). Returns the platform's id of this computer.
 */
export async function shareForRecording(apps: AllowedApp[]): Promise<number> {
  if (config.slug)
    throw new Error(
      'Este computador é o posto de um único funcionário: desligue o posto para compartilhar com o funcionário da gravação.'
    )
  if (config.share) {
    const have = new Set(config.apps.map((a) => a.process.toLowerCase()))
    const missing = apps.filter((a) => !have.has(a.process.toLowerCase()))
    if (missing.length) await updateShare({ apps: [...config.apps, ...missing] })
    return config.share.id
  }
  await share({ apps, authMode: 'ask', allowManaged: true, teamIds: [] })
  const id = shareId()
  if (id === undefined) throw new Error('Não consegui compartilhar este computador.')
  return id
}

const shareId = (): number | undefined => config.share?.id
