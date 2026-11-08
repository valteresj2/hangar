// IPC channels and payload types for "gravar uma tarefa": the person records the apps she chose (what she clicks and
// types, read by the system's accessibility API, plus a capture of the window at each click) and her narration (the
// microphone); she reviews it, the platform turns it into a draft (procedure, variables, confirmations, schedule,
// questions) and, after her review, hires a Digital employee in shadow mode and probation that does the task on this
// computer. Design: docs/platform/record-to-agent-plan.md.
import type { AllowedApp } from './computer'

export const RECORDER = {
  /** () → RecorderState */
  state: 'recorder:state',
  /** (input: StartRecording) → RecorderState — starts recording the chosen apps. */
  start: 'recorder:start',
  /** () → RecorderState */
  pause: 'recorder:pause',
  /** () → RecorderState */
  resume: 'recorder:resume',
  /** () → RecorderState — stops; the recording waits for the person's review (nothing left this computer). */
  stop: 'recorder:stop',
  /** (id, audio: Uint8Array, mime) → RecordingDetail — the narration recorded by the window (stored encrypted). */
  saveAudio: 'recorder:saveAudio',
  /** (id) → RecordingDetail — the recording, its steps and the frames (data URLs) for the review. */
  get: 'recorder:get',
  /** (id, patch: RecordingPatch) → RecordingDetail — the person edits before sending (removes steps, notes, title). */
  update: 'recorder:update',
  /** (id) → RecorderState — deletes everything of a recording on this computer. */
  discard: 'recorder:discard',
  /** (id) → RecordingDetail — sends the narration to the platform's speech model (the audio is not kept there). */
  transcribe: 'recorder:transcribe',
  /** (id) → RecordingDetail — sends the package (steps, transcript, notes, the frames of the steps) for the draft. */
  send: 'recorder:send',
  /** (id, draft: RecordingDraft) → RecordingDetail — saves the person's edits of the draft. */
  saveDraft: 'recorder:saveDraft',
  /** (id, input: HireInput) → RecordingDetail — hires the employee (shadow + probation) from the reviewed draft. */
  hire: 'recorder:hire',

  /** main → renderer: RecorderState after every change. */
  evState: 'recorder:event:state'
} as const

export interface StartRecording {
  title: string
  apps: AllowedApp[]
  /** The window records the microphone (the narration). */
  microphone: boolean
}

/** One thing the person did, as the recording registered it. */
export interface RecordedStep {
  /** ms since the recording started (pauses excluded). */
  t: number
  kind: 'click' | 'type' | 'key' | 'window'
  app?: string
  window?: string
  /** click: the element under the pointer (accessibility name and type). */
  element?: { name: string; type: string }
  button?: 'left' | 'right'
  /** type: the field and its final value; a password field never has a value. */
  field?: string
  value?: string
  password?: boolean
  /** key: the shortcut ("ctrl+s", "Return"). */
  key?: string
  /** A click or a window change in an app that was not chosen: nothing else about it is kept. */
  outside?: boolean
  /** Index of the capture of the window at this step, if any. */
  frame?: number
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export type RecordingStatus = 'recording' | 'paused' | 'review' | 'sending' | 'drafted' | 'hired' | 'failed'

export interface RecordingSummary {
  id: string
  title: string
  createdAt: number
  durationMs: number
  status: RecordingStatus
  steps: number
  audio: boolean
  apps: string[]
  employee?: { slug: string; name: string }
}

export interface DraftStep {
  n: number
  app: string
  action: 'open' | 'click' | 'type' | 'key' | 'scroll' | 'check' | 'wait'
  target: string
  value?: string
  /** This step confirms something (saves, sends, pays): it asks for approval. */
  confirms?: boolean
  note?: string
}

/** What the platform's model understood from the recording, for the person to correct before hiring. */
export interface RecordingDraft {
  title: string
  mission: string
  summary: string
  steps: DraftStep[]
  variables: { name: string; description: string; source: string; example?: string }[]
  confirmations: { step: number; description: string }[]
  apps: string[]
  schedule: { cron: string; text: string; timezone?: string }
  questions: { question: string; answer: string }[]
  secrets: { name: string; field: string }[]
  probation: { title: string; description: string; expected: string }[]
}

export interface RecordingDetail extends RecordingSummary {
  appList: AllowedApp[]
  recordedOn: string
  timeline: RecordedStep[]
  /** Data URLs of the captures, by frame index (only for the review; never leave the computer before "Enviar"). */
  frames: Record<number, string>
  notes: string
  transcript: TranscriptSegment[]
  platformId?: number
  draft?: RecordingDraft
  error?: string
}

export interface RecordingPatch {
  title?: string
  notes?: string
  /** Step indices to drop (and their frames). */
  removeSteps?: number[]
  /** Drop the audio (keep only the typed notes). */
  removeAudio?: boolean
}

export interface HireInput {
  draft: RecordingDraft
  /** Share this computer (asking at each loan, with the recording's apps) so the employee can rehearse and work. */
  shareComputer: boolean
}

export interface RecorderState {
  supported: boolean
  why?: string
  active?: {
    id: string
    title: string
    paused: boolean
    elapsedMs: number
    steps: number
    microphone: boolean
    apps: string[]
    limitMs: number
  }
  recordings: RecordingSummary[]
  /** Days a recording stays on this computer. */
  retentionDays: number
}

/** A step as one line of text (the review, the package, the tests). */
export function describeStep(s: RecordedStep): string {
  if (s.outside) return s.kind === 'window' ? 'foi para outro app (não gravado)' : 'clicou em outro app (não gravado)'
  const where = s.app ? ` em ${s.app}` : ''
  if (s.kind === 'click') {
    const el = s.element && (s.element.name || s.element.type)
    const what = el ? `${s.element!.type ? `${s.element!.type} ` : ''}"${s.element!.name}"` : 'um ponto da janela'
    return `${s.button === 'right' ? 'clique direito' : 'clicou'} em ${what}${where}`
  }
  if (s.kind === 'type')
    return s.password
      ? `digitou a senha no campo "${s.field ?? ''}"${where}`
      : `escreveu "${s.value ?? ''}" no campo "${s.field ?? ''}"${where}`
  if (s.kind === 'key') return `apertou ${s.key}${where}`
  return `abriu a janela "${s.window ?? ''}"${where}`
}

declare module '../ipc' {
  interface IpcInvokeContract {
    [RECORDER.state]: () => RecorderState
    [RECORDER.start]: (input: StartRecording) => RecorderState
    [RECORDER.pause]: () => RecorderState
    [RECORDER.resume]: () => RecorderState
    [RECORDER.stop]: () => RecorderState
    [RECORDER.saveAudio]: (id: string, audio: Uint8Array, mime: string) => RecordingDetail
    [RECORDER.get]: (id: string) => RecordingDetail
    [RECORDER.update]: (id: string, patch: RecordingPatch) => RecordingDetail
    [RECORDER.discard]: (id: string) => RecorderState
    [RECORDER.transcribe]: (id: string) => RecordingDetail
    [RECORDER.send]: (id: string) => RecordingDetail
    [RECORDER.saveDraft]: (id: string, draft: RecordingDraft) => RecordingDetail
    [RECORDER.hire]: (id: string, input: HireInput) => RecordingDetail
  }
  interface IpcEventContract {
    [RECORDER.evState]: RecorderState
  }
}
