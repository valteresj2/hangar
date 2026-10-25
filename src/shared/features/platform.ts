// IPC channels and payload types for the "platform" feature (connection to an Agent Hangar platform).
// Owned by the platform agent. Contract with the platform: docs/platform/app-api-phase1.md and
// docs/platform/app-api-models.md (synced token models).

export const PLATFORM = {
  /** () → PlatformState */
  state: 'platform:state',
  /** (patch: PlatformConfigPatch) → PlatformState — values locked by Windows policy are ignored. */
  setConfig: 'platform:setConfig',
  /** () → PlatformState — runs the OAuth loopback login in the system browser (resolves when it ends). */
  connect: 'platform:connect',
  /** () → void — aborts a login in progress. */
  cancelConnect: 'platform:cancelConnect',
  /** () → PlatformState — revokes the tokens, forgets them and stops the heartbeat. */
  disconnect: 'platform:disconnect',
  /** () → PlatformState — reloads /api/app/me and sends a heartbeat. */
  refresh: 'platform:refresh',
  /** () → PlatformState — fetches the synced token models now (also done on connect, every 15 min and on resume). */
  syncModels: 'platform:syncModels',
  /**
   * (sessionId, choice: ModelChoice) → void — runs the session on that provider profile and model. A session that
   * never ran just takes them; a running one switches provider like engine:setProvider (the runner restarts).
   */
  chooseModel: 'platform:chooseModel',
  /** (choice: ModelChoice) → void — default provider profile and model of new sessions. */
  setDefaultModel: 'platform:setDefaultModel',

  /** main → renderer: PlatformState after every change. */
  evState: 'platform:event:state'
} as const

/** `off`: no platform; `optional`: hybrid (connect if you want); `required`: no sessions until connected. */
export type PlatformMode = 'off' | 'optional' | 'required'

export const PLATFORM_MODES: PlatformMode[] = ['off', 'optional', 'required']

/** Where an effective config value came from. */
export type PlatformValueSource = 'default' | 'user' | 'policy-machine' | 'policy-user'

export interface PlatformConfig {
  /** Base URL of the platform (no trailing slash); '' when not configured. */
  url: string
  mode: PlatformMode
  source: { url: PlatformValueSource; mode: PlatformValueSource }
  /** Values set by Windows policy (HKLM/HKCU \Software\Policies\Hangar) cannot be changed in the app. */
  locked: { url: boolean; mode: boolean }
}

export interface PlatformConfigPatch {
  url?: string
  mode?: PlatformMode
}

export type PlatformStatus =
  | 'off' // mode off
  | 'unconfigured' // no URL
  | 'disconnected'
  | 'connecting' // login running in the browser
  | 'connected'
  | 'error' // connected before, but the platform cannot be reached / answered with an error

export interface PlatformTeam {
  id: string
  slug: string
  name: string
}

export interface PlatformUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
  orgRole?: string
  teams: PlatformTeam[]
}

export interface PlatformOrg {
  id: string
  name: string
  slug: string
}

export interface PlatformDevice {
  /** UUID generated and kept by the app. */
  deviceId: string
  name: string
  status: 'active' | 'revoked' | 'unregistered'
  registeredAt?: number
  lastSeenAt?: number
}

export interface PlatformNotice {
  tone: 'info' | 'warn' | 'error'
  message: string
  at: number
}

export interface PlatformState {
  config: PlatformConfig
  status: PlatformStatus
  user?: PlatformUser
  org?: PlatformOrg
  platformVersion?: string
  device: PlatformDevice
  /** Readable error (pt-BR) of the last failed operation. */
  error?: string
  /** Something the user should see once (device revoked, session expired…). */
  notice?: PlatformNotice
  lastHeartbeatAt?: number
  /** False when mode is `required` and the app is not connected: sessions cannot be created. */
  canCreateSessions: boolean
  /** Token models synced from the platform (GET /api/app/models), each connection as a managed provider profile. */
  models: PlatformModels
}

/** One model of a synced connection, as the app shows it (prices in USD per 1M tokens). */
export interface PlatformModel {
  id: string
  name: string
  contextLength?: number
  caps?: string[]
  priceInPerMTok?: number
  priceOutPerMTok?: number
}

/** An LLM connection of the platform synced to the app, reached through the platform's proxy. */
export interface PlatformConnection {
  id: number
  name: string
  /** Provider of the connection on the platform (anthropic, openrouter, litellm…). */
  provider: string
  /** Path of the connection's proxy on the platform (`/api/app/llm/<id>`). */
  basePath: string
  /** Managed provider profile (src/shared/providers.ts) that points at this connection's proxy. */
  profileId: string
  models: PlatformModel[]
}

export interface PlatformModels {
  /** `unsupported`: the platform has no /api/app/models (older version). */
  status: 'none' | 'syncing' | 'ok' | 'error' | 'unsupported'
  /** Changes on the platform whenever the list changes. */
  version?: string
  syncedAt?: number
  /** Readable error (pt-BR) of the last failed sync; the previous list stays in use. */
  error?: string
  connections: PlatformConnection[]
}

/** A provider profile + model pair, as the model picker chooses it. */
export interface ModelChoice {
  providerId: string
  model: string
}

/** Id of the managed provider profile of a platform connection. */
export const managedProfileId = (connectionId: number): string => `platform-${connectionId}`

/** Message shown when a session is refused because the platform is required (main and renderer). */
export const PLATFORM_REQUIRED_MESSAGE =
  'Sua empresa exige conexão com a plataforma Agent Hangar para criar sessões. Conecte em Configurações → Plataforma.'

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [PLATFORM.state]: () => PlatformState
    [PLATFORM.setConfig]: (patch: PlatformConfigPatch) => PlatformState
    [PLATFORM.connect]: () => PlatformState
    [PLATFORM.cancelConnect]: () => void
    [PLATFORM.disconnect]: () => PlatformState
    [PLATFORM.refresh]: () => PlatformState
    [PLATFORM.syncModels]: () => PlatformState
    [PLATFORM.chooseModel]: (sessionId: string, choice: ModelChoice) => void
    [PLATFORM.setDefaultModel]: (choice: ModelChoice) => void
  }

  interface IpcEventContract {
    [PLATFORM.evState]: PlatformState
  }
}
