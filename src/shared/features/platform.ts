// IPC channels and payload types for the "platform" feature (connection to an Agent Hangar platform).
// Owned by the platform agent. Contract with the platform: docs/platform/app-api-phase1.md.

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
}

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
  }

  interface IpcEventContract {
    [PLATFORM.evState]: PlatformState
  }
}
