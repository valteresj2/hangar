// Typed wrappers for the computer feature's IPC, plus a store that mirrors ComputerState from main.
import { create } from 'zustand'
import {
  COMPUTER,
  type AllowedApp,
  type ComputerState,
  type EnableInput,
  type ShareInput
} from '@shared/features/computer'
import { bridge } from '../../core/api'

export const computerApi = {
  state: () => bridge.invoke(COMPUTER.state),
  employees: () => bridge.invoke(COMPUTER.employees),
  installedApps: () => bridge.invoke(COMPUTER.installedApps),
  enable: (input: EnableInput) => bridge.invoke(COMPUTER.enable, input),
  disable: (returnToPlatform: boolean) => bridge.invoke(COMPUTER.disable, returnToPlatform),
  setApps: (apps: AllowedApp[]) => bridge.invoke(COMPUTER.setApps, apps),
  setResumeAfter: (s: number) => bridge.invoke(COMPUTER.setResumeAfter, s),
  stop: () => bridge.invoke(COMPUTER.stop),
  resume: () => bridge.invoke(COMPUTER.resume),
  resumeNow: () => bridge.invoke(COMPUTER.resumeNow),
  teams: () => bridge.invoke(COMPUTER.teams),
  share: (input: ShareInput) => bridge.invoke(COMPUTER.share, input),
  updateShare: (patch: Partial<ShareInput>) => bridge.invoke(COMPUTER.updateShare, patch),
  unshare: () => bridge.invoke(COMPUTER.unshare),
  answer: (leaseId: number, allow: boolean) => bridge.invoke(COMPUTER.answer, leaseId, allow)
}

export const useComputerStore = create<{ state?: ComputerState }>(() => ({}))

let subscribed = false
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  bridge.on(COMPUTER.evState, (state) => useComputerStore.setState({ state }))
  void computerApi
    .state()
    .then((state) => useComputerStore.setState((s) => (s.state ? s : { state })))
    .catch((err) => console.warn('[computer] state failed', err))
}

export function useComputer(): ComputerState | undefined {
  subscribe()
  return useComputerStore((s) => s.state)
}

export const STATUS_LABEL: Record<ComputerState['status'], string> = {
  off: 'Desligado',
  idle: 'Ligado — aguardando',
  working: 'Trabalhando neste computador',
  paused: 'Pausado — você está usando o computador',
  stopped: 'Parado',
  error: 'Com problema'
}
