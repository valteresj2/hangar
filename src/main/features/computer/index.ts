// Feature "computer" — main process side: this computer as the workstation of a Digital employee the person manages
// (computer use of this machine's screen, only in the apps allowed here, with an indicator, a kill switch, a pause when
// the person uses the computer and the platform's authority). Design: docs/platform/computer-workstation-plan.md.
import { COMPUTER, type AllowedApp, type EnableInput, type ShareInput } from '../../../shared/features/computer'
import {
  RECORDER,
  type HireInput,
  type RecordingDraft,
  type RecordingPatch,
  type StartRecording
} from '../../../shared/features/recorder'
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import {
  answer,
  disable,
  dispose,
  enable,
  getState,
  installedApps,
  managedEmployees,
  resume,
  resumeNow,
  setApps,
  setResumeAfter,
  share,
  start,
  stop,
  teams,
  unshare,
  updateShare
} from './controller'
import * as recorder from './recorder'

export const computerFeature: Feature = {
  name: 'computer',
  register() {
    handle(COMPUTER.state, () => getState())
    handle(COMPUTER.employees, () => managedEmployees())
    handle(COMPUTER.installedApps, () => installedApps())
    handle(COMPUTER.enable, (_e, input: EnableInput) => enable(input))
    handle(COMPUTER.disable, (_e, back: boolean) => disable(back === true))
    handle(COMPUTER.setApps, (_e, apps: AllowedApp[]) => setApps(apps))
    handle(COMPUTER.setResumeAfter, (_e, s: number) => setResumeAfter(Number(s)))
    handle(COMPUTER.stop, () => stop())
    handle(COMPUTER.resume, () => resume())
    handle(COMPUTER.resumeNow, () => resumeNow())
    handle(COMPUTER.teams, () => teams())
    handle(COMPUTER.share, (_e, input: ShareInput) => share(input))
    handle(COMPUTER.updateShare, (_e, patch: Partial<ShareInput>) => updateShare(patch ?? {}))
    handle(COMPUTER.unshare, () => unshare())
    handle(COMPUTER.answer, (_e, leaseId: number, allow: boolean) => {
      if (!Number.isInteger(leaseId)) throw new Error('Pedido inválido.')
      return answer(leaseId, allow === true)
    })
    void start().catch((e) => console.warn('[hangar] posto no computador:', (e as Error).message))

    // Gravar uma tarefa (docs/platform/record-to-agent-plan.md)
    const id = (v: unknown): string => {
      if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v)) throw new Error('Gravação inválida.')
      return v
    }
    handle(RECORDER.state, () => recorder.getState())
    handle(RECORDER.start, (_e, input: StartRecording) => recorder.start(input))
    handle(RECORDER.pause, () => recorder.pause())
    handle(RECORDER.resume, () => recorder.resume())
    handle(RECORDER.stop, () => recorder.stop())
    handle(RECORDER.saveAudio, (_e, rid: string, audio: Uint8Array, mime: string) =>
      recorder.saveAudio(id(rid), audio, mime)
    )
    handle(RECORDER.get, (_e, rid: string) => recorder.get(id(rid)))
    handle(RECORDER.update, (_e, rid: string, patch: RecordingPatch) => recorder.update(id(rid), patch ?? {}))
    handle(RECORDER.discard, (_e, rid: string) => recorder.discard(id(rid)))
    handle(RECORDER.transcribe, (_e, rid: string) => recorder.transcribe(id(rid)))
    handle(RECORDER.send, (_e, rid: string) => recorder.send(id(rid)))
    handle(RECORDER.saveDraft, (_e, rid: string, draft: RecordingDraft) => recorder.saveDraft(id(rid), draft))
    handle(RECORDER.hire, (_e, rid: string, input: HireInput) => recorder.hire(id(rid), input))
    recorder.startRecorder()
  },
  async dispose() {
    await recorder.disposeRecorder()
    return dispose()
  }
}
