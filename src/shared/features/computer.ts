// IPC channels and payload types for the "computer" feature: this computer as the workstation of a Digital employee
// the person manages — the employee looks at the screen and operates the apps the person allowed here, with a visible
// indicator, a kill switch, a pause when the person uses the computer and the platform's authority for anything that
// confirms something. Design: docs/platform/computer-workstation-plan.md. Second mode: this computer shared with the
// platform's employees, who borrow it when they need a screen step (docs/platform/computer-shared-workstations-plan.md).

export const COMPUTER = {
  /** () → ComputerState */
  state: 'computer:state',
  /** () → ManagedEmployee[] — the Digital employees the person manages (GET /api/employees?mine=1). */
  employees: 'computer:employees',
  /** () → InstalledApp[] — apps found on this computer (Start menu shortcuts and open windows) for the picker. */
  installedApps: 'computer:installedApps',
  /** (input: EnableInput) → ComputerState — this computer becomes the employee's workstation (asks the platform for its worker token). */
  enable: 'computer:enable',
  /** (returnToPlatform: boolean) → ComputerState — turns the workstation off (optionally the employee goes back to the platform runtime). */
  disable: 'computer:disable',
  /** (apps: AllowedApp[]) → ComputerState — the apps the employee may open and operate here. */
  setApps: 'computer:setApps',
  /** (resumeAfterS: number) → ComputerState — seconds without the person's input before the employee acts again. */
  setResumeAfter: 'computer:setResumeAfter',
  /** () → ComputerState — kill switch: stops the employee now (the task goes back to the platform; stays off). */
  stop: 'computer:stop',
  /** () → ComputerState — turns the workstation back on after a stop. */
  resume: 'computer:resume',
  /** () → ComputerState — act now even though the person used the computer a moment ago. */
  resumeNow: 'computer:resumeNow',
  /** () → TeamOption[] — the person's teams (who else may borrow this computer). */
  teams: 'computer:teams',
  /** (input: ShareInput) → ComputerState — shares this computer with the platform's employees (registers it). */
  share: 'computer:share',
  /** (patch: Partial<ShareInput>) → ComputerState — who may borrow it, how the person authorizes, the apps. */
  updateShare: 'computer:updateShare',
  /** () → ComputerState — stops sharing (the platform forgets this computer; a loan in use ends). */
  unshare: 'computer:unshare',
  /** (leaseId, allow) → ComputerState — the person answers a loan request. */
  answer: 'computer:answer',

  /** main → renderer: ComputerState after every change. */
  evState: 'computer:event:state'
} as const

/** An app the person allowed on this computer. Matched by process name (and executable path when known). */
export interface AllowedApp {
  /** What the employee calls it in desktop_open ("Bloco de Notas", "Excel"). */
  name: string
  /** Process name without extension ("notepad", "EXCEL"). */
  process: string
  /** Executable or shortcut to start it (empty: only operate it when it is already open). */
  launch?: string
  /** Shown with a warning in the picker (browser, terminal, file explorer). */
  warning?: string
}

/** An app found on this computer, for the picker. `blocked`: can never be allowed (why). */
export interface InstalledApp extends AllowedApp {
  source: 'start-menu' | 'window'
  blocked?: string
}

export interface ManagedEmployee {
  slug: string
  name: string
  title: string
  status: string
  /** hangar | external */
  runtime: string
}

/** off: not set up · idle: waiting for tasks · working · paused: the person is using the computer · stopped: kill switch · error */
export type ComputerStatus = 'off' | 'idle' | 'working' | 'paused' | 'stopped' | 'error'

/** worker: this computer is one employee's workstation · shared: the platform's employees borrow it. */
export type ComputerMode = 'off' | 'worker' | 'shared'

/** ask: the person allows each loan · preauthorized: no question, only the indicator. */
export type AuthMode = 'ask' | 'preauthorized'

export interface TeamOption {
  id: number
  name: string
}

export interface ShareSettings {
  id: number
  name: string
  authMode: AuthMode
  /** The employees the person manages may borrow it. */
  allowManaged: boolean
  /** And the employees of these teams. */
  teamIds: number[]
}

export interface ShareInput {
  apps: AllowedApp[]
  authMode: AuthMode
  allowManaged: boolean
  teamIds: number[]
}

/** A loan of this computer (requested or in use), as the platform reports it. */
export interface LeaseInfo {
  lease_id: number
  request_id?: number | null
  employee: string
  employee_slug: string
  task_id: number
  task_title: string
  app: string
  reason: string
  status: string
}

export interface ComputerAction {
  at: number
  taskId: number
  tool: string
  summary: string
  ok: boolean
}

export interface ComputerState {
  /** False on a system without a driver (Windows, macOS and Linux have one). */
  supported: boolean
  unsupportedReason?: string
  /** The platform login is needed to choose an employee. */
  connected: boolean
  status: ComputerStatus
  employee?: { slug: string; name: string }
  apps: AllowedApp[]
  resumeAfterS: number
  task?: { id: number; title: string }
  /** Readable (pt-BR) detail of the current status (what it is doing, why it paused, the error). */
  detail?: string
  /** The last actions on the screen (newest first). */
  recent: ComputerAction[]
  /** A limitation of this computer (Wayland, no accessibility on Linux…), shown in the panel. */
  notice?: string
  /** Global shortcut of the kill switch. */
  stopShortcut: string
  mode: ComputerMode
  /** Shared mode: how this computer is shared. */
  share?: ShareSettings
  /** Shared mode: loan requests waiting for the person's answer. */
  requests: LeaseInfo[]
  /** Shared mode: the loan in use. */
  borrower?: LeaseInfo
}

export interface EnableInput {
  slug: string
  apps: AllowedApp[]
}

declare module '../ipc' {
  interface IpcInvokeContract {
    [COMPUTER.state]: () => ComputerState
    [COMPUTER.employees]: () => ManagedEmployee[]
    [COMPUTER.installedApps]: () => InstalledApp[]
    [COMPUTER.enable]: (input: EnableInput) => ComputerState
    [COMPUTER.disable]: (returnToPlatform: boolean) => ComputerState
    [COMPUTER.setApps]: (apps: AllowedApp[]) => ComputerState
    [COMPUTER.setResumeAfter]: (resumeAfterS: number) => ComputerState
    [COMPUTER.stop]: () => ComputerState
    [COMPUTER.resume]: () => ComputerState
    [COMPUTER.resumeNow]: () => ComputerState
    [COMPUTER.teams]: () => TeamOption[]
    [COMPUTER.share]: (input: ShareInput) => ComputerState
    [COMPUTER.updateShare]: (patch: Partial<ShareInput>) => ComputerState
    [COMPUTER.unshare]: () => ComputerState
    [COMPUTER.answer]: (leaseId: number, allow: boolean) => ComputerState
  }
  interface IpcEventContract {
    [COMPUTER.evState]: ComputerState
  }
}
