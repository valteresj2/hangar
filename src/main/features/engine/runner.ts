// One Runner per Hangar session: keeps a streaming-input query() alive so the session can take
// several messages, be interrupted and change model/mode while running.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  RewindFilesResult,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { broadcast } from '../../core/broadcast'
import { bus } from '../../core/bus'
import { collectSystemAppend } from '../../core/prompts'
import { db, settings } from '../../core/store'
import type { PermissionMode, Session, SessionStatus } from '../../../shared/contracts'
import {
  DEFAULT_SESSION_TITLES,
  ENGINE,
  type EngineOptions,
  type EngineState,
  type PastedImage,
  type PermissionRequest,
  type PermissionResponse,
  type SendOptions,
  type SlashCommandInfo,
  type TranscriptEntry
} from '../../../shared/features/engine'
import { fromAssistantContent, parseQuestions, toolResultsFromUserContent, writtenPath, type EntryDraft } from './convert'
import { claudeEnv, loadSdk, MessageQueue, resolveClaudeExecutable, toCommandInfo } from './sdk'
import { isValidImage, saveImage } from './images'
import { isMotionPath, motionCard, motionInstructions } from './motion'
import { rewindPoint, setRewindPoint } from './points'
import { appendEntries, makeEntry } from './transcript'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const HANGAR_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

interface Pending {
  request: PermissionRequest
  input: Record<string, unknown>
  suggestions: PermissionUpdate[]
  resolve(result: PermissionResult): void
}

export interface RunnerHost {
  isActive(sessionId: string): boolean
}

type UserContent = SDKUserMessage['message']['content']

export class Runner {
  private q: Query | undefined
  private input: MessageQueue | undefined
  private starting: Promise<void> | undefined
  private pending = new Map<string, Pending>()
  private toolUses = new Map<string, { name: string; input: Record<string, unknown> }>()
  /** Tools the user allowed "always" when the CLI offered no rule suggestion to persist. */
  private alwaysAllowed = new Set<string>()
  /** *.motion.json files written or edited during the current turn. */
  private motionWrites = new Set<string>()
  private inflight = 0
  private interrupting = false
  private stderrTail: string[] = []
  private lastContextTokens: number | undefined
  private streamText = ''
  private streamThinking = ''
  commands: SlashCommandInfo[] = []

  constructor(
    readonly sessionId: string,
    private readonly host: RunnerHost
  ) {}

  get running(): boolean {
    return !!this.q
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

  // ── Sending ────────────────────────────────────────────────────────────

  async send(text: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session()
    const attachments = opts.attachments?.filter(Boolean) ?? []
    const pasted = opts.images?.filter(isValidImage) ?? []
    if (!text.trim() && attachments.length === 0 && pasted.length === 0) return

    const patch: Partial<Session> = {}
    if (DEFAULT_SESSION_TITLES.includes(session.title.trim()) && text.trim()) patch.title = makeTitle(text)

    const images = await Promise.all(pasted.map((img) => saveImage(this.sessionId, img)))
    const motion = opts.output === 'motion'
    // Our own UUID becomes the message's id in the Claude Code session: the anchor for rewind and fork.
    const sdkUuid = randomUUID()
    this.record({
      kind: 'user',
      text,
      sdkUuid,
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(motion ? { output: 'motion' as const } : {})
    })
    // The Motion guide rides along as an extra text block only Claude sees; the runner keeps running as is.
    const hidden = motion ? await motionInstructions(this.sessionId) : undefined
    const content = await buildContent(text, attachments, pasted, hidden)
    this.inflight++
    this.interrupting = false
    this.setStatus('working', patch)

    try {
      await this.ensureStarted()
    } catch (err) {
      this.inflight = 0
      this.record({ kind: 'error', message: `Falha ao iniciar o Claude Code: ${errorText(err)}` })
      this.setStatus('error')
      throw err
    }
    this.input?.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: sdkUuid })
  }

  ensureStarted(): Promise<void> {
    if (this.q) return Promise.resolve()
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async start(): Promise<void> {
    const sdk = await loadSdk()
    const session = this.session()
    const defaults = settings().get()
    const projectInstructions = session.projectId ? db('projects').get(session.projectId)?.instructions?.trim() : undefined
    const instructions = [projectInstructions, ...collectSystemAppend(session)].filter(Boolean).join('\n\n')
    const input = new MessageQueue()
    this.stderrTail = []

    const options: Options = {
      cwd: session.worktree?.path ?? session.cwd,
      model: session.model ?? defaults.defaultModel,
      effort: session.effort ?? defaults.defaultEffort,
      permissionMode: session.permissionMode ?? defaults.defaultPermissionMode,
      // Lets the user switch to "Ignorar permissões" mid-session; the mode itself is still opt-in.
      allowDangerouslySkipPermissions: true,
      resume: session.sdkSessionId,
      ...(session.sdkSessionId && rewindPoint(this.sessionId) ? { resumeSessionAt: rewindPoint(this.sessionId) } : {}),
      // Checkpoints let a rewind also restore files; replayed user messages confirm our UUIDs landed.
      enableFileCheckpointing: true,
      extraArgs: { 'replay-user-messages': null },
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      env: claudeEnv(),
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
      ...(session.fastMode ? { settings: { fastMode: true } } : {}),
      canUseTool: this.canUseTool,
      stderr: (data) => {
        this.stderrTail.push(data)
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      }
    }

    const q = sdk.query({ prompt: input, options })
    this.q = q
    this.input = input
    void this.consume(q)
    q.supportedCommands().then(
      (cmds) => (this.commands = cmds.map(toCommandInfo)),
      () => undefined
    )
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) this.handle(message)
    } catch (err) {
      if (this.q === q && !this.interrupting) {
        const tail = this.stderrTail.join('').trim().split('\n').slice(-5).join('\n')
        this.record({ kind: 'error', message: [errorText(err), tail].filter(Boolean).join('\n') })
        this.inflight = 0
        this.setStatus('error')
        bus.emit('session:turn-ended', { sessionId: this.sessionId, result: 'error' })
      }
    } finally {
      if (this.q === q) {
        this.q = undefined
        this.input = undefined
        this.denyAllPending('A sessão foi encerrada.')
        if (this.inflight > 0) {
          this.inflight = 0
          this.setStatus('idle')
        }
      }
    }
  }

  // ── Message handling ───────────────────────────────────────────────────

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        return this.handleSystem(m)
      case 'stream_event': {
        if (m.parent_tool_use_id) return
        const ev = m.event
        if (ev.type === 'message_start') {
          this.streamText = ''
          this.streamThinking = ''
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') {
            this.streamText += ev.delta.text
            broadcast(ENGINE.evDelta, { sessionId: this.sessionId, kind: 'text', text: ev.delta.text })
          } else if (ev.delta.type === 'thinking_delta') {
            this.streamThinking += ev.delta.thinking
            broadcast(ENGINE.evDelta, { sessionId: this.sessionId, kind: 'thinking', text: ev.delta.thinking })
          }
        }
        return
      }
      case 'assistant': {
        // Subagent traffic stays out of the main transcript; its outcome arrives as the Agent tool result.
        if (m.parent_tool_use_id) return
        const usage = m.message.usage
        if (usage) {
          this.lastContextTokens =
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        }
        const drafts = fromAssistantContent(m.message.content)
        for (const d of drafts) {
          if (d.kind === 'tool_use') this.toolUses.set(d.toolUseId, { name: d.name, input: d.input })
          if (d.kind === 'assistant') this.streamText = ''
          if (d.kind === 'thinking') this.streamThinking = ''
        }
        this.record(...drafts)
        return
      }
      case 'user': {
        if ('isReplay' in m && m.isReplay) {
          // A message now sits after the rewind point: that branch is the session's latest, resume normally.
          if (!m.parent_tool_use_id && rewindPoint(this.sessionId)) setRewindPoint(this.sessionId, undefined)
          return
        }
        if (m.parent_tool_use_id) return
        const drafts = toolResultsFromUserContent(m.message.content)
        this.record(...drafts)
        for (const d of drafts) {
          if (d.kind !== 'tool_result' || d.isError) continue
          const use = this.toolUses.get(d.toolUseId)
          const path = use && writtenPath(use.name, use.input)
          if (!path) continue
          bus.emit('session:file-written', { sessionId: this.sessionId, path })
          if (isMotionPath(path)) this.motionWrites.add(path)
        }
        return
      }
      case 'result':
        return this.handleResult(m)
      default:
        return
    }
  }

  private handleSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init': {
        const session = db('sessions').get(this.sessionId)
        if (session && session.sdkSessionId !== m.session_id) db('sessions').patch(this.sessionId, { sdkSessionId: m.session_id })
        return
      }
      case 'commands_changed':
        this.commands = m.commands.map(toCommandInfo)
        return
      case 'status': {
        if (m.status === 'compacting') this.record({ kind: 'system', text: 'Compactando o contexto…' })
        if (m.compact_result === 'failed') this.record({ kind: 'error', message: `Falha ao compactar: ${m.compact_error ?? ''}` })
        // Plan approval (ExitPlanMode) and similar flows switch the mode on the CLI side; mirror it.
        const mode = m.permissionMode as PermissionMode | undefined
        const current = db('sessions').get(this.sessionId)
        if (current && mode && HANGAR_MODES.includes(mode) && current.permissionMode !== mode) {
          db('sessions').patch(this.sessionId, { permissionMode: mode })
        }
        return
      }
      case 'compact_boundary':
        this.record({ kind: 'system', text: `Contexto compactado (${m.compact_metadata.pre_tokens.toLocaleString('pt-BR')} tokens antes).` })
        return
      case 'local_command_output':
        this.record({ kind: 'assistant', text: m.content })
        return
      case 'informational':
        if (m.level === 'warning' || m.level === 'notice') this.record({ kind: 'system', text: m.content })
        return
      case 'api_retry':
        this.record({ kind: 'system', text: `Erro da API (${m.error}); nova tentativa ${m.attempt}/${m.max_retries}…` })
        return
      default:
        return
    }
  }

  private handleResult(m: Extract<SDKMessage, { type: 'result' }>): void {
    const wasInterrupt = this.interrupting
    this.interrupting = false
    this.streamText = ''
    this.streamThinking = ''
    this.inflight = Math.max(0, m.queued_turn_count ?? 0)

    const modelUsage = Object.values(m.modelUsage ?? {})
    const contextWindow = modelUsage.reduce((max, u) => Math.max(max, u.contextWindow ?? 0), 0) || undefined
    const errors = m.subtype === 'success' ? (m.is_error && m.result ? [m.result] : []) : m.errors
    // One card per animation touched this turn, showing the file as it ended up.
    if (this.motionWrites.size) {
      this.record(...[...this.motionWrites].map(motionCard))
      this.motionWrites.clear()
    }
    this.record({
      kind: 'result',
      subtype: m.subtype,
      isError: m.is_error && !wasInterrupt,
      durationMs: m.duration_ms,
      costUsd: m.total_cost_usd,
      numTurns: m.num_turns,
      inputTokens: m.usage.input_tokens ?? 0,
      outputTokens: m.usage.output_tokens ?? 0,
      cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
      contextTokens: this.lastContextTokens,
      contextWindow,
      ...(errors.length && !wasInterrupt ? { errors } : {})
    })

    if (wasInterrupt) this.record({ kind: 'system', text: 'Interrompido pelo usuário.' })
    else if (errors.some((e) => /no conversation found/i.test(e))) {
      // The CLI lost the conversation we tried to resume: start fresh next time.
      db('sessions').patch(this.sessionId, { sdkSessionId: undefined })
      this.record({ kind: 'error', message: 'Não foi possível retomar a conversa anterior; a próxima mensagem inicia uma nova conversa.' })
    }

    if (this.inflight > 0) return
    const failed = m.is_error && !wasInterrupt
    this.setStatus(failed ? 'error' : 'idle', this.host.isActive(this.sessionId) ? {} : { unread: true })
    bus.emit('session:turn-ended', { sessionId: this.sessionId, result: failed ? 'error' : 'success' })
  }

  // ── Permissions ────────────────────────────────────────────────────────

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const isQuestion = toolName === 'AskUserQuestion'
    if (!isQuestion && this.alwaysAllowed.has(toolName)) return { behavior: 'allow', updatedInput: input }

    const request: PermissionRequest = {
      requestId: opts.requestId || randomUUID(),
      toolName,
      toolUseId: opts.toolUseID,
      input,
      title: opts.title,
      displayName: opts.displayName,
      description: opts.description,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      canAlwaysAllow: !isQuestion && !opts.suppressAlwaysAllowRule,
      ...(isQuestion ? { questions: parseQuestions(input) } : {})
    }
    this.record({ kind: 'permission_request', request })

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(request.requestId, { request, input, suggestions: opts.suggestions ?? [], resolve })
      broadcast(ENGINE.evPermission, { sessionId: this.sessionId, type: 'request', request })
      this.setStatus('waiting')
      bus.emit('session:needs-input', { sessionId: this.sessionId, reason: isQuestion ? 'question' : 'permission' })
      opts.signal.addEventListener('abort', () => {
        if (!this.pending.has(request.requestId)) return
        this.settle(request.requestId, { decision: 'deny', message: 'Cancelado.' }, { interrupt: true })
      })
    })
  }

  respond(requestId: string, response: PermissionResponse): void {
    if (!this.pending.has(requestId)) return
    this.settle(requestId, response)
  }

  private settle(requestId: string, response: PermissionResponse, opts: { interrupt?: boolean } = {}): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    const { request } = p

    let result: PermissionResult
    if (response.decision === 'deny') {
      const message = response.message?.trim() || (request.questions ? 'O usuário dispensou a pergunta.' : 'O usuário negou esta ação.')
      result = { behavior: 'deny', message, interrupt: opts.interrupt, decisionClassification: 'user_reject' }
    } else if (request.questions) {
      result = { behavior: 'allow', updatedInput: { ...p.input, answers: response.answers ?? {} } }
    } else if (response.decision === 'allow_always') {
      // "Always" is scoped to this session: rewrite the CLI's suggestions to the session destination.
      const updatedPermissions = p.suggestions.map((s) => ({ ...s, destination: 'session' as const }))
      if (updatedPermissions.length === 0) this.alwaysAllowed.add(request.toolName)
      result = { behavior: 'allow', updatedInput: p.input, updatedPermissions, decisionClassification: 'user_permanent' }
    } else {
      result = { behavior: 'allow', updatedInput: p.input, decisionClassification: 'user_temporary' }
    }

    this.record({
      kind: 'permission_decision',
      requestId,
      decision: response.decision,
      ...(response.message ? { message: response.message } : {}),
      ...(response.answers ? { answers: response.answers } : {})
    })
    broadcast(ENGINE.evPermission, { sessionId: this.sessionId, type: 'resolved', requestId })
    p.resolve(result)
    if (this.pending.size === 0 && this.inflight > 0) this.setStatus('working')
  }

  private denyAllPending(message: string, interrupt = false): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { decision: 'deny', message }, { interrupt })
  }

  // ── Control ────────────────────────────────────────────────────────────

  async interrupt(): Promise<void> {
    if (!this.q) return
    this.interrupting = true
    this.denyAllPending('O usuário interrompeu.', true)
    try {
      await this.q.interrupt()
    } catch (err) {
      this.interrupting = false
      this.record({ kind: 'error', message: `Falha ao interromper: ${errorText(err)}` })
    }
  }

  /** Restores files edited from `userUuid` on (or previews it). Starts the query without sending anything. */
  async rewindFiles(userUuid: string, dryRun: boolean): Promise<RewindFilesResult> {
    await this.ensureStarted()
    if (!this.q) return { canRewind: false, error: 'Sessão não iniciada.' }
    return this.q.rewindFiles(userUuid, { dryRun })
  }

  async setOptions(patch: EngineOptions): Promise<void> {
    db('sessions').patch(this.sessionId, patch)
    const q = this.q
    if (!q) return
    try {
      if (patch.model !== undefined) await q.setModel(patch.model || undefined)
      if (patch.permissionMode !== undefined) await q.setPermissionMode(patch.permissionMode)
      if (patch.effort !== undefined) await q.applyFlagSettings({ effortLevel: patch.effort })
      if (patch.fastMode !== undefined) await q.applyFlagSettings({ fastMode: patch.fastMode })
    } catch (err) {
      this.record({ kind: 'error', message: `Não foi possível aplicar a opção agora: ${errorText(err)}` })
    }
  }

  close(): void {
    const q = this.q
    this.q = undefined
    this.input?.close()
    this.input = undefined
    this.denyAllPending('A sessão foi encerrada.', true)
    try {
      q?.close()
    } catch {
      // Already gone.
    }
  }
}

function makeTitle(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function buildContent(text: string, attachments: string[], pasted: PastedImage[], hidden?: string): Promise<UserContent> {
  if (attachments.length === 0 && pasted.length === 0 && !hidden) return text
  type Part =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  const parts: Part[] = pasted.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }))
  const referenced: string[] = []
  for (const path of attachments) {
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()]
    if (mediaType) {
      try {
        const data = await readFile(path)
        if (data.byteLength <= MAX_IMAGE_BYTES) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: data.toString('base64') }
          })
          continue
        }
      } catch {
        // Unreadable image: fall back to referencing its path.
      }
    }
    referenced.push(path)
  }
  const list = referenced.map((p) => `- ${p} (${basename(p)})`).join('\n')
  const body = [text, referenced.length ? `Arquivos anexados (leia se precisar):\n${list}` : ''].filter(Boolean).join('\n\n')
  if (body) parts.push({ type: 'text', text: body })
  if (hidden) parts.push({ type: 'text', text: hidden })
  return parts as UserContent
}
