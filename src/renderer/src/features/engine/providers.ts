// Provider profiles in the chat: the list (no secrets) and the model choices a profile offers.
import { useEffect, useState } from 'react'
import type { StoreChange } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import { CORE } from '@shared/ipc'
import type { ProviderModels, ProviderProfile } from '@shared/providers'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'

/** Profiles, refreshed when settings change, when Configurações closes and when the window regains focus. */
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
    window.addEventListener('focus', load)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', load)
    }
  }, [settingsOpen])
  return list
}

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const

/** Aliases (with the model the profile maps them to) plus the profile's default and extra model ids. */
export function modelChoices(models: ProviderModels | undefined): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = ALIASES.map((alias) => {
    const mapped = alias !== 'fable' ? models?.[alias] : undefined
    const name = alias[0].toUpperCase() + alias.slice(1)
    return { value: alias, label: mapped ? `${name} · ${mapped}` : name }
  })
  const seen = new Set<string>(ALIASES)
  if (models?.default && !seen.has(models.default)) {
    out.push({ value: models.default, label: `${models.default} (padrão do perfil)` })
    seen.add(models.default)
  }
  for (const id of models?.extra ?? []) {
    if (!id || seen.has(id)) continue
    out.push({ value: id, label: id })
    seen.add(id)
  }
  return out
}
