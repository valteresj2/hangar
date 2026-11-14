// A session running on the Hangar Harness instead of Claude Code: same surface as Runner (../runner.ts), so the
// registry, the IPC handlers and every other feature treat the two engines alike. The harness speaks the OpenAI chat
// API natively, so gateway profiles reach open and third-party models without the Anthropic compat layer.
//
// Each harness event becomes the transcript entry the interface already draws: tool calls are renamed to their
// Claude Code equivalents (diff cards, checklist, shell output), approvals become permission cards, ask_user becomes a
// question card, and a turn ends with the usual result line (cost, tokens, context).
import { randomUUID } from 'node:crypto'
import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk'
import { broadcast } from '../../../core/broadcast'
import { bus } from '../../../core/bus'
import { collectSystemAppend } from '../../../core/prompts'
import { db, settings } from '../../../core/store'
import { PLATFORM_MCP_NAME, platformMcpServer } from '../../platform/api'
import { resolveProviderLaunch } from '../../settings/providers-api'
import type { Session, SessionStatus } from '../../../../shared/contracts'
import {
  DEFAULT_SESSION_TITLES,
  ENGINE,
  type EngineOptions,
  type EngineState,
  type PermissionRequest,
  type PermissionResponse,
  type SendOptions,
  type SlashCommandInfo,
  type TranscriptEntry
} from '../../../../shared/features/engine'
import { parseQuestions, writtenPath, type EntryDraft } from '../convert'
import { isValidImage, saveImage } from '../images'
import { isMotionPath, motionCard, motionInstructions } from '../motion'
import { effectiveProviderId, isProviderFailure, maskSecrets, providerInfo, type ProviderInfo } from '../providers'
import type { RunnerHost } from '../runner'
import { appendEntries, makeEntry } from '../transcript'
import { HangarBridge, type BridgeEvent } from './bridge'
import { recordFlow } from './flow'
import {
  effortFor,
  freshInputTokens,
  isProviderErrorKind,
  mapTool,
  openAiBaseUrl,
  permissionFor,
  resolveModel,
  type MappedTool
} from './map'

const MAX_RESULT_CHARS = 30_000
const READY_TIMEOUT_MS = 90_000

interface Pending {
  request: PermissionRequest
  /** Id of the question/permission on the harness side. */
  qid: string
  kind: 'permission' | 'question'
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export class HangarRunner {
  readonly engine = 'hangar' as const
  /** The project's slash commands (.claude/commands), as the harness reported them when it started. */
  commands: SlashCommandInfo[] = []
  private bridge: HangarBridge | undefined
  private starting: Promise<void> | undefined
  private ready: { resolve(): void; reject(err: Error): void } | undefined
  private pending = new Map<string, Pending>()
  private toolUses = new Map<string, MappedTool>()
  /** Id of the most recent tool call, per harness tool name: what a permission request refers to. */
  private lastToolId = new Map<string, string>()
  private motionWrites = new Set<string>()
  private inflight = 0
  private interrupting = false
  private provider: ProviderInfo | undefined
  private secrets: string[] = []
  private cwd = ''
  private streamText = ''
  private streamThinking = ''
  /** The main agent's latest message of the turn: what the graph's result node shows. */
  private lastAnswer = ''

  constructor(
    readonly sessionId: string,
    private readonly host: RunnerHost
  ) {}

  get running(): boolean {
    return !!this.bridge?.alive
  }

  state(): EngineState {
    return {
      running: this.running,
      busy: this.inflight > 0,
      pending: [...this.pending.values()].map((p) => p.request),
      streamText: this.streamText,
      streamThinking: this.streamThinking
    }
  }

  private session(): Session {
    const s = db('sessions').get(this.sessionId)
    if (!s) throw new Error(`Sessão ${this.sessionId} não encontrada`)
    return s
  }

  // ── Transcript & status ────────────────────────────────────────────────

  private record(...drafts: EntryDraft[]): TranscriptEntry[] {
    const entries = drafts.map((d) => makeEntry(d))
    appendEntries(this.sessionId, entries)
    for (const entry of entries) broadcast(ENGINE.evEntry, { sessionId: this.sessionId, entry })
    return entries
  }

  private setStatus(status: SessionStatus, extra: Partial<Session> = {}): void {
    const current = db('sessions').get(this.sessionId)
    if (!current) return
    db('sessions').patch(this.sessionId, { status, updatedAt: Date.now(), ...extra })
    broadcast(ENGINE.evStatus, { sessionId: this.sessionId, status, busy: this.inflight > 0 })
    if (current.status !== status) bus.emit('session:status', { sessionId: this.sessionId, status })
  }

  private mask(message: string): string {
    return maskSecrets(message, this.secrets)
  }

  // ── Sending ────────────────────────────────────────────────────────────

  async send(prompt: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session()
    const attachments = opts.attachments?.filter(Boolean) ?? []
    const pasted = opts.images?.filter(isValidImage) ?? []
    if (!prompt.trim() && attachments.length === 0 && pasted.length === 0) return

    const patch: Partial<Session> = {}
    if (DEFAULT_SESSION_TITLES.includes(session.title.trim()) && prompt.trim()) patch.title = makeTitle(prompt)

    const images = await Promise.all(pasted.map((img) => saveImage(this.sessionId, img)))
    const motion = opts.output === 'motion'
    this.record({
      kind: 'user',
      text: prompt,
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(motion ? { output: 'motion' as const } : {})
    })
    const hidden = motion ? await motionInstructions(this.sessionId) : undefined
    this.inflight++
    this.interrupting = false
    this.lastAnswer = ''
    recordFlow(this.sessionId, {
      type: 'turn',
      text: prompt,
      model: resolveModel(session.model, resolveProviderLaunch(effectiveProviderId(session)).models) ?? ''
    })
    this.setStatus('working', patch)

    try {
      await this.ensureStarted()
    } catch (err) {
      this.inflight = 0
      const info = providerInfo(effectiveProviderId(session))
      const message = this.mask(err instanceof Error ? err.message : String(err))
      if (isProviderFailure(message)) {
        this.record({
          kind: 'provider_error',
          providerId: info.id,
          providerName: info.name,
          message: `Falha ao iniciar o motor Hangar com este perfil: ${message}`
        })
      } else {
        this.record({ kind: 'error', message: `Falha ao iniciar o motor Hangar: ${message}` })
      }
      this.setStatus('error')
      throw err
    }
    this.bridge?.send({
      type: 'user',
      text: prompt,
      attachments,
      images: pasted,
      ...(hidden ? { hidden } : {})
    })
  }

  ensureStarted(): Promise<void> {
    if (this.bridge?.alive) return Promise.resolve()
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private start(): Promise<void> {
    const session = this.session()
    const defaults = settings().get()
    const providerId = effectiveProviderId(session)
    const launch = resolveProviderLaunch(providerId)
    this.provider = providerInfo(providerId)
    const base = launch.env.ANTHROPIC_BASE_URL
    if (!base)
      throw new Error('Este perfil não tem URL base: o motor Hangar precisa de um gateway compatível com OpenAI.')
    const apiKey = launch.env.ANTHROPIC_AUTH_TOKEN || launch.env.ANTHROPIC_API_KEY || undefined
    this.secrets = apiKey && apiKey.length >= 6 ? [apiKey] : []
    const model = resolveModel(session.model, launch.models)
    if (!model)
      throw new Error(
        'Escolha um modelo para esta sessão (ou defina o modelo padrão do perfil): o motor Hangar não tem um modelo implícito.'
      )
    const projectInstructions = session.projectId
      ? db('projects').get(session.projectId)?.instructions?.trim()
      : undefined
    const instructions = [projectInstructions, ...collectSystemAppend(session)].filter(Boolean).join('\n\n')
    const platformMcp = platformMcpServer()
    this.cwd = session.worktree?.path ?? session.cwd
    this.pending.clear()
    this.toolUses.clear()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = undefined
        this.closeBridge()
        reject(new Error('O motor Hangar não respondeu ao iniciar.'))
      }, READY_TIMEOUT_MS)
      this.ready = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      }
      try {
        const bridge: HangarBridge = new HangarBridge({
          apiKey,
          start: {
            cwd: this.cwd,
            model,
            base_url: openAiBaseUrl(base),
            permission: permissionFor(session.permissionMode ?? defaults.defaultPermissionMode),
            effort: effortFor(session.effort ?? defaults.defaultEffort),
            ...(instructions ? { system_append: instructions } : {}),
            ...(platformMcp ? { mcp_servers: { [PLATFORM_MCP_NAME]: { url: platformMcp.url } } } : {}),
            ...(session.hangarSessionId ? { resume: session.hangarSessionId } : {}),
            ...(launch.compat?.contextWindow ? { context_window: launch.compat.contextWindow } : {}),
            // The folder is the user's project (or a Lab variant of it): its .claude/ hooks apply, as in Claude Code.
            trust_project: true,
            // Verified project facts (how to run the tests, where things live) carry over between conversations.
            memory: true,
            title: session.title
          },
          onEvent: (ev) => this.handle(ev),
          onExit: (code, stderr) => this.exited(bridge, code, stderr)
        })
        this.bridge = bridge
      } catch (err) {
        this.ready = undefined
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private exited(bridge: HangarBridge, code: number | null, stderr: string): void {
    if (this.bridge !== bridge) return
    this.bridge = undefined
    const waiting = this.ready
    this.ready = undefined
    this.denyAllPending('A sessão foi encerrada.')
    if (waiting)
      return waiting.reject(new Error(stderr || `O motor Hangar encerrou ao iniciar (código ${code ?? '?'}).`))
    if (this.inflight > 0 && !this.interrupting) {
      this.record({
        kind: 'error',
        message: this.mask(`O motor Hangar encerrou inesperadamente (código ${code ?? '?'}).\n${stderr}`.trim())
      })
      this.inflight = 0
      this.setStatus('error')
      bus.emit('session:turn-ended', { sessionId: this.sessionId, result: 'error' })
    } else if (this.inflight > 0) {
      this.inflight = 0
      this.setStatus('idle')
    }
  }

  // ── Events from the harness ────────────────────────────────────────────

  private handle(ev: BridgeEvent): void {
    // Sub-agents, the perception model and the compactor stay out of the main transcript, like Claude Code's
    // subagent traffic: their outcome arrives as the result of the tool that started them.
    const agent = typeof ev.agent === 'string' ? ev.agent : 'work'
    const main = agent === 'work' || agent === 'main'
    // The graph's own turn markers are written in send() and turnEnded(), with what the app knows.
    if (ev.type !== 'turn' && ev.type !== 'turn_end') recordFlow(this.sessionId, ev, (t) => this.mask(t))
    switch (ev.type) {
      case 'ready': {
        const id = text(ev.session)
        if (id && this.session().hangarSessionId !== id) db('sessions').patch(this.sessionId, { hangarSessionId: id })
        if (Array.isArray(ev.commands))
          this.commands = ev.commands.map(record).flatMap((c) =>
            text(c.name)
              ? [
                  {
                    name: text(c.name),
                    description: text(c.description),
                    argumentHint: text(c.argumentHint) || undefined
                  }
                ]
              : []
          )
        this.ready?.resolve()
        this.ready = undefined
        return
      }
      case 'fatal': {
        const waiting = this.ready
        this.ready = undefined
        const message = this.mask(text(ev.message))
        if (waiting) waiting.reject(new Error(message))
        else this.record({ kind: 'error', message })
        return
      }
      case 'delta': {
        if (!main) return
        const chunk = text(ev.text)
        if (ev.kind === 'reasoning') {
          this.streamThinking += chunk
          broadcast(ENGINE.evDelta, { sessionId: this.sessionId, kind: 'thinking', text: chunk })
        } else {
          this.streamText += chunk
          broadcast(ENGINE.evDelta, { sessionId: this.sessionId, kind: 'text', text: chunk })
        }
        return
      }
      case 'thinking':
        if (!main) return
        this.streamThinking = ''
        if (text(ev.text).trim()) this.record({ kind: 'thinking', text: text(ev.text) })
        return
      case 'assistant':
        if (!main) return
        this.streamText = ''
        if (text(ev.text).trim()) {
          this.lastAnswer = text(ev.text)
          this.record({ kind: 'assistant', text: text(ev.text) })
        }
        return
      case 'tool_start': {
        if (!main) return
        const id = text(ev.id) || randomUUID()
        const name = text(ev.name)
        const mapped = mapTool(name, record(ev.args), this.cwd)
        this.toolUses.set(id, mapped)
        this.lastToolId.set(name, id)
        this.streamText = ''
        this.record({ kind: 'tool_use', toolUseId: id, name: mapped.name, input: mapped.input })
        return
      }
      case 'tool_end': {
        if (!main) return
        const id = text(ev.id)
        const use = this.toolUses.get(id)
        if (!use) return
        const raw = text(ev.output) || text(ev.preview)
        const content = raw.length > MAX_RESULT_CHARS ? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (saída truncada)` : raw
        const isError = ev.ok === false
        this.record({ kind: 'tool_result', toolUseId: id, content, isError })
        bus.emit('session:tool-result', {
          sessionId: this.sessionId,
          name: use.name,
          input: use.input,
          content,
          isError
        })
        if (isError) return
        const path = writtenPath(use.name, use.input)
        if (!path) return
        bus.emit('session:file-written', { sessionId: this.sessionId, path })
        if (isMotionPath(path)) this.motionWrites.add(path)
        return
      }
      case 'permission':
        return this.askPermission(ev)
      case 'question':
        if (ev.kind === 'approval') return // answered through the 'permission' event of the same request
        return this.askQuestion(ev)
      case 'notice': {
        if (!main && ev.level !== 'error') return
        const message = this.mask(text(ev.text))
        if (ev.level === 'error') this.record({ kind: 'error', message })
        else this.record({ kind: 'system', text: message })
        return
      }
      case 'compact':
        if (main && ev.tier === 2)
          this.record({ kind: 'system', text: 'Contexto compactado para continuar a conversa.' })
        return
      case 'memory': {
        const saved = Array.isArray(ev.saved) ? ev.saved.map((n) => text(n)).filter(Boolean) : []
        const stale = Array.isArray(ev.stale) ? ev.stale.map((n) => text(n)).filter(Boolean) : []
        if (saved.length) {
          const fact = text(ev.fact)
          this.record({
            kind: 'system',
            text: this.mask(`Memória do projeto: guardou ${saved.join(', ')}${fact ? ` — ${fact}` : ''}`)
          })
        } else if (stale.length) {
          this.record({
            kind: 'system',
            text: this.mask(`Memória do projeto: ${stale.join(', ')} saiu de uso (${text(ev.reason)})`)
          })
        }
        return
      }
      case 'hook':
        this.record({
          kind: 'system',
          text: `Regra do projeto (${text(ev.event)} · ${text(ev.action)}): ${this.mask(text(ev.message))}`
        })
        return
      case 'turn_end':
        return this.turnEnded(ev)
      default:
        return
    }
  }

  private turnEnded(ev: BridgeEvent): void {
    const status = text(ev.status)
    const wasInterrupt = this.interrupting || status === 'interrupted'
    this.interrupting = false
    this.streamText = ''
    this.streamThinking = ''
    this.inflight = Math.max(0, this.inflight - 1)
    this.denyAllPending('A rodada terminou.', false)

    const failed = (status === 'error' || status === 'incomplete') && !wasInterrupt
    const error = this.mask(text(ev.error))
    recordFlow(
      this.sessionId,
      {
        type: 'turn_end',
        status: wasInterrupt ? 'interrupted' : status || 'error',
        text: wasInterrupt ? '' : this.lastAnswer,
        error
      },
      (t) => this.mask(t)
    )
    if (this.motionWrites.size) {
      this.record(...[...this.motionWrites].map(motionCard))
      this.motionWrites.clear()
    }
    const prompt = num(ev.prompt)
    const cached = num(ev.cached)
    const cacheWrite = num(ev.cache_write)
    this.record({
      kind: 'result',
      subtype: status === 'success' ? 'success' : status || 'error',
      isError: failed,
      durationMs: num(ev.duration_ms),
      costUsd: num(ev.session_cost),
      numTurns: num(ev.steps),
      inputTokens: freshInputTokens(prompt, cached, cacheWrite),
      outputTokens: num(ev.completion),
      cacheReadTokens: cached,
      cacheCreationTokens: cacheWrite,
      contextTokens: num(ev.context_tokens) || undefined,
      contextWindow: num(ev.context_window) || undefined,
      ...(failed && error ? { errors: [error] } : {}),
      ...(text(ev.model) ? { model: text(ev.model) } : {}),
      ...(this.provider
        ? { providerId: this.provider.id, providerName: this.provider.name, providerKind: this.provider.kind }
        : {})
    })
    if (wasInterrupt) this.record({ kind: 'system', text: 'Interrompido pelo usuário.' })
    else if (
      status === 'error' &&
      this.provider &&
      (isProviderErrorKind(text(ev.error_kind)) || isProviderFailure(error))
    )
      this.record({
        kind: 'provider_error',
        providerId: this.provider.id,
        providerName: this.provider.name,
        message: error || 'O provedor não respondeu.'
      })
    else if (status === 'incomplete')
      this.record({ kind: 'system', text: `A tarefa não foi concluída: ${error || 'limite atingido'}.` })

    if (this.inflight > 0) return
    this.setStatus(failed ? 'error' : 'idle', this.host.isActive(this.sessionId) ? {} : { unread: true })
    bus.emit('session:turn-ended', { sessionId: this.sessionId, result: failed ? 'error' : 'success' })
  }

  note(message: string): void {
    this.record({ kind: 'system', text: message })
  }

  // ── Permissions and questions ──────────────────────────────────────────

  private askPermission(ev: BridgeEvent): void {
    const tool = text(ev.tool)
    const mapped = mapTool(tool, record(ev.args), this.cwd)
    const request: PermissionRequest = {
      requestId: randomUUID(),
      toolName: mapped.name,
      toolUseId: this.lastToolId.get(tool) ?? '',
      input: mapped.input,
      title: text(ev.title) || undefined,
      canAlwaysAllow: ev.can_always === true
    }
    this.open(request, text(ev.qid), 'permission')
  }

  private askQuestion(ev: BridgeEvent): void {
    const options = Array.isArray(ev.options) ? ev.options.map((o) => ({ label: String(o) })) : []
    const input = { questions: [{ question: text(ev.question), options }] }
    const request: PermissionRequest = {
      requestId: randomUUID(),
      toolName: 'AskUserQuestion',
      toolUseId: this.lastToolId.get('ask_user') ?? '',
      input,
      canAlwaysAllow: false,
      questions: parseQuestions(input)
    }
    this.open(request, text(ev.qid), 'question')
  }

  private open(request: PermissionRequest, qid: string, kind: Pending['kind']): void {
    this.record({ kind: 'permission_request', request })
    this.pending.set(request.requestId, { request, qid, kind })
    broadcast(ENGINE.evPermission, { sessionId: this.sessionId, type: 'request', request })
    this.setStatus('waiting')
    bus.emit('session:needs-input', {
      sessionId: this.sessionId,
      reason: kind === 'question' ? 'question' : 'permission'
    })
  }

  respond(requestId: string, response: PermissionResponse): void {
    if (!this.pending.has(requestId)) return
    this.settle(requestId, response)
  }

  private settle(requestId: string, response: PermissionResponse, tellHarness = true): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (tellHarness) {
      if (p.kind === 'question') {
        const answers = Object.values(response.answers ?? {}).filter(Boolean)
        const answer =
          response.decision === 'deny'
            ? response.message?.trim() || '(o usuário dispensou a pergunta)'
            : answers.join('; ') || response.message?.trim() || ''
        this.bridge?.send({ type: 'answer', qid: p.qid, answer })
      } else {
        this.bridge?.send({
          type: 'permission_response',
          qid: p.qid,
          decision: response.decision,
          ...(response.message?.trim() ? { message: response.message.trim() } : {})
        })
      }
    }
    this.record({
      kind: 'permission_decision',
      requestId,
      decision: response.decision,
      ...(response.message ? { message: response.message } : {}),
      ...(response.answers ? { answers: response.answers } : {})
    })
    broadcast(ENGINE.evPermission, { sessionId: this.sessionId, type: 'resolved', requestId })
    if (this.pending.size === 0 && this.inflight > 0) this.setStatus('working')
  }

  private denyAllPending(message: string, tellHarness = true): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { decision: 'deny', message }, tellHarness)
  }

  // ── Control ────────────────────────────────────────────────────────────

  interrupt(): Promise<void> {
    if (!this.bridge?.alive) return Promise.resolve()
    this.interrupting = true
    this.denyAllPending('O usuário interrompeu.')
    this.bridge.send({ type: 'interrupt' })
    return Promise.resolve()
  }

  /** File checkpoints are a Claude Code feature; the harness keeps its own undo (`hangar undo`). */
  rewindFiles(userUuid: string, dryRun: boolean): Promise<RewindFilesResult> {
    void userUuid
    void dryRun
    return Promise.resolve({
      canRewind: false,
      error: 'Voltar arquivos não está disponível em sessões do motor Hangar.'
    })
  }

  setOptions(patch: EngineOptions): Promise<void> {
    db('sessions').patch(this.sessionId, patch)
    if (!this.bridge?.alive) return Promise.resolve()
    const session = this.session()
    const model =
      patch.model !== undefined
        ? resolveModel(patch.model, resolveProviderLaunch(effectiveProviderId(session)).models)
        : undefined
    this.bridge.send({
      type: 'set_options',
      ...(model ? { model } : {}),
      ...(patch.permissionMode !== undefined ? { permission: permissionFor(patch.permissionMode) } : {}),
      ...(patch.effort !== undefined ? { effort: effortFor(patch.effort) } : {})
    })
    return Promise.resolve()
  }

  private closeBridge(): void {
    const bridge = this.bridge
    this.bridge = undefined
    bridge?.close()
  }

  close(): void {
    this.denyAllPending('A sessão foi encerrada.', false)
    this.closeBridge()
    if (this.inflight > 0) {
      this.inflight = 0
      this.setStatus('idle')
    }
  }
}

function makeTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}
