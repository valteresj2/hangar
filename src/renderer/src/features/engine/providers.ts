// Provider profiles in the chat: the list (no secrets). The model picker itself is the platform feature's
// ModelPicker (subscription, synced token models and the other profiles in one <select>).
import { useEffect, useState } from 'react'
import type { StoreChange } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import { SETTINGS } from '@shared/features/settings'
import { CORE } from '@shared/ipc'
import type { ProviderProfile } from '@shared/providers'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'

/**
 * Profiles, refreshed when they or the settings change (the platform's managed profiles come and go with each
 * sync), when Configurações closes and when the window regains focus.
 */
export function useProviders(): ProviderProfile[] {
  const [list, setList] = useState<ProviderProfile[]>([])
  const settingsOpen = useUi((s) => s.settingsOpen)
  useEffect(() => {
    let alive = true
    const load = () =>
      void bridge.invoke(ENGINE.providers).then(
        (l) => alive && setList(l),
        () => undefined
      )
    load()
    const off = bridge.on(CORE.storeChanged, (c: StoreChange) => {
      if (c.collection === 'settings') load()
    })
    const offProviders = bridge.on(SETTINGS.providersChanged, load)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      off()
      offProviders()
      window.removeEventListener('focus', load)
    }
  }, [settingsOpen])
  return list
}
