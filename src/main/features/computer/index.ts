// Feature "computer" — main process side: this computer as the workstation of a Digital employee the person manages
// (computer use of this machine's screen, only in the apps allowed here, with an indicator, a kill switch, a pause when
// the person uses the computer and the platform's authority). Design: docs/platform/computer-workstation-plan.md.
import { COMPUTER, type AllowedApp, type EnableInput, type ShareInput } from '../../../shared/features/computer'
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
  },
  dispose() {
    return dispose()
  }
}
