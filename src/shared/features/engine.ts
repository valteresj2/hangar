// IPC channels and payload types for the "engine" feature. Owned by the engine agent.
import type { Effort, PermissionMode, SessionStatus } from '../contracts'

export const ENGINE = {
  /** (sessionId, text, opts?: SendOptions) → void */
  send: 'engine:send',
  /** (sessionId) → void */
  interrupt: 'engine:interrupt',
  /** (sessionId) → TranscriptEntry[] */
  history: 'engine:history',
  /** (query) → SearchHit[] */
  search: 'engine:search',
  /** (sessionId, requestId, response: PermissionResponse) → void */
  respondPermission: 'engine:respondPermission',
  /** (sessionId | undefined) → void — which session the user is looking at */
  setActive: 'engine:setActive',
  /** (sessionId, patch: EngineOptions) → void — persists on the session and applies to the live query */
  setOptions: 'engine:setOptions',
  /** (sessionId) → SlashCommandInfo[] */
  slashCommands: 'engine:slashCommands',
  /** (sessionId) → EngineState — live state for a (re)mounted chat view */
  state: 'engine:state',
  /** (sessionId, query) → string[] — up to 50 paths relative to the session folder, for @mentions */
  listFiles: 'engine:listFiles',
  /** (path) → string | undefined — data URL of an image saved under the engine images folder */
  readImage: 'engine:readImage',
  /** (sessionId, entryId) → RewindPreview — what rewinding to that user message would undo in files */
  rewindPreview: 'engine:rewindPreview',
  /** (sessionId, entryId, opts: RewindOptions) → RewindResult — drops that message and everything after it */
  rewind: 'engine:rewind',
  /** (sessionId, entryId) → ForkResult — new session with the history up to that message's turn */
  fork: 'engine:fork',

  evEntry: 'engine:event:entry',
  evDelta: 'engine:event:delta',
  evPermission: 'engine:event:permission',
  evStatus: 'engine:event:status',
  /** { sessionId } — the transcript changed wholesale (rewind); reload history */
  evReset: 'engine:event:reset',
  /** { sessionId } — ask the renderer to select a session (after a fork) */
  evSelect: 'engine:event:select'
} as const

export interface SendOptions {
  /** Absolute file paths. Images are sent inline; other files are referenced by path. */
  attachments?: string[]
  /** Images without a file (pasted or dropped from a browser), already under 5 MB. */
  images?: PastedImage[]
  /** Special output for this turn: 'motion' hands Claude the Hangar Motion guide (hidden from the transcript). */
  output?: OutputMode
}

export type OutputMode = 'motion'

export interface PastedImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** Base64, no data: prefix. */
  data: string
}

export interface RewindPreview {
  /** The conversation point was found in the Claude Code session. */
  canRewindConversation: boolean
  /** File checkpoints exist for that point (sessions created with checkpointing on). */
  canRewindFiles: boolean
  filesChanged: string[]
  insertions?: number
  deletions?: number
  /** Why files cannot be restored, when they cannot. */
  filesError?: string
}

export interface RewindOptions {
  /** Also restore files edited (Write/Edit/NotebookEdit) from that message on. */
  restoreFiles?: boolean
}

export interface RewindResult {
  /** The removed message, to put back in the composer. */
  text: string
  attachments?: string[]
  images?: PastedImage[]
  /** Output mode the removed message was sent with. */
  output?: OutputMode
  filesRestored?: string[]
  filesError?: string
}

export interface ForkResult {
  sessionId: string
}

export interface EngineOptions {
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  fastMode?: boolean
}

export interface SearchHit {
  sessionId: string
  snippet: string
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint?: string
}

interface EntryBase {
  id: string
  ts: number
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

/** One persisted transcript line (JSONL in <userData>/hangar-data/engine/transcripts/<sessionId>.jsonl). */
export type TranscriptEntry =
  | (EntryBase & {
      kind: 'user'
      text: string
      attachments?: string[]
      /** Saved copies of pasted images (absolute paths under the engine images folder). */
      images?: string[]
      /** UUID sent with the message to Claude Code; it is the message's id in the CLI session (rewind/fork point). */
      sdkUuid?: string
      output?: OutputMode
    })
  | (EntryBase & {
      kind: 'motion'
      /** Absolute path of a *.motion.json written or edited during the turn. */
      path: string
      title?: string
      /** Total seconds. */
      duration?: number
      scenes?: number
      /** parseMotion errors (empty when valid). */
      errors: string[]
    })
  | (EntryBase & { kind: 'assistant'; text: string; parentToolUseId?: string })
  | (EntryBase & { kind: 'thinking'; text: string })
  | (EntryBase & {
      kind: 'tool_use'
      toolUseId: string
      name: string
      input: Record<string, unknown>
      parentToolUseId?: string
    })
  | (EntryBase & { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean })
  | (EntryBase & { kind: 'permission_request'; request: PermissionRequest })
  | (EntryBase & {
      kind: 'permission_decision'
      requestId: string
      decision: PermissionDecision
      message?: string
      answers?: Record<string, string>
    })
  | (EntryBase & {
      kind: 'result'
      subtype: string
      isError: boolean
      durationMs: number
      /** Cumulative cost of the live query, in USD (estimate). */
      costUsd: number
      numTurns: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      contextTokens?: number
      contextWindow?: number
      errors?: string[]
    })
  | (EntryBase & { kind: 'system'; text: string })
  | (EntryBase & { kind: 'error'; message: string })

export type TranscriptKind = TranscriptEntry['kind']

export type PermissionDecision = 'allow' | 'allow_always' | 'deny'

export interface PermissionRequest {
  requestId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  /** Full prompt sentence from the CLI, when it provides one. */
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  /** False when the CLI asks us not to offer a persistent "always allow". */
  canAlwaysAllow: boolean
  /** Set for AskUserQuestion: the request is a set of questions, not an approval. */
  questions?: Question[]
}

export interface PermissionResponse {
  decision: PermissionDecision
  /** Shown to Claude when denying. */
  message?: string
  /** AskUserQuestion answers keyed by question text. */
  answers?: Record<string, string>
}

export interface EntryEvent {
  sessionId: string
  entry: TranscriptEntry
}

export interface DeltaEvent {
  sessionId: string
  kind: 'text' | 'thinking'
  text: string
}

export type PermissionEvent =
  | { sessionId: string; type: 'request'; request: PermissionRequest }
  | { sessionId: string; type: 'resolved'; requestId: string }

export interface StatusEvent {
  sessionId: string
  status: SessionStatus
  busy: boolean
}

export interface EngineState {
  running: boolean
  busy: boolean
  pending: PermissionRequest[]
  /** Text streamed so far for the assistant block in progress. */
  streamText: string
  streamThinking: string
}

export const DEFAULT_SESSION_TITLES = ['Nova sessão', 'New session', '']
