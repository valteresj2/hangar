import type { HangarBridge } from '../shared/ipc'

declare global {
  interface Window {
    hangar: HangarBridge
  }
}

export {}
