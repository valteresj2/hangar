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

  evEntry: 'engine:event:entry',
  evDelta: 'engine:event:delta',
  evPermission: 'engine:event:permission',
  evStatus: 'engine:event:status'
} as const

export interface SendOptions {
  /** Absolute file paths. Images are sent inline; other files are referenced by path. */
  attachments?: string[]
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
  | (EntryBase & { kind: 'user'; text: string; attachments?: string[] })
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
