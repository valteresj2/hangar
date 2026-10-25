// Synced token models in the renderer: provider profiles (no secrets), the model picker's groups and the
// origin / estimated cost shown under a turn. Docs: docs/platform/app-api-models.md.
import { useEffect, useState } from 'react'
import type { StoreChange } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import type { ModelChoice, PlatformConnection, PlatformModel, PlatformModels } from '@shared/features/platform'
import { SETTINGS } from '@shared/features/settings'
import { CORE } from '@shared/ipc'
import { SUBSCRIPTION_PROFILE_ID, type ProviderModels, type ProviderProfile } from '@shared/providers'
import { bridge } from '../../core/api'
import { usePlatformStore } from './api'

const NO_MODELS: PlatformModels = { status: 'none', connections: [] }

/** Synced token models of the current login (empty when disconnected). */
export function usePlatformModels(): PlatformModels {
  return usePlatformStore((s) => s.state?.models ?? NO_MODELS)
}

/** Provider profiles (no secrets), reloaded whenever they or the settings change. */
export function useProviderProfiles(): ProviderProfile[] {
  const [list, setList] = useState<ProviderProfile[]>([])
  useEffect(() => {
    let alive = true
    const load = () =>
      void bridge.invoke(ENGINE.providers).then(
        (l) => alive && setList(l),
        () => undefined
      )
    load()
    const offProviders = bridge.on(SETTINGS.providersChanged, load)
    const offStore = bridge.on(CORE.storeChanged, (c: StoreChange) => {
      if (c.collection === 'settings') load()
    })
    window.addEventListener('focus', load)
    return () => {
      alive = false
      offProviders()
      offStore()
      window.removeEventListener('focus', load)
    }
  }, [])
  return list
}

// ---------------------------------------------------------------- formatting

export function formatContext(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1)).toLocaleString('pt-BR')}M`
  return `${Math.round(tokens / 1000)}k`
}

export function formatUsd(value: number): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: value > 0 && value < 1 ? 2 : 0,
    maximumFractionDigits: value < 0.1 ? 4 : 2
  })
}

/** "US$ 3 / 15 por 1M" (input / output), or undefined without prices. */
export function priceLabel(m: PlatformModel): string | undefined {
  if (m.priceInPerMTok === undefined && m.priceOutPerMTok === undefined) return undefined
  const v = (n: number | undefined) => (n === undefined ? '—' : formatUsd(n))
  return `US$ ${v(m.priceInPerMTok)} / ${v(m.priceOutPerMTok)} por 1M`
}

// ---------------------------------------------------------------- picker groups

export interface PickerOption {
  value: string
  label: string
  /** Tooltip with the details (prices: input / output). */
  title?: string
  choice: ModelChoice
}

export interface PickerGroup {
  label: string
  options: PickerOption[]
}

const SEP = '\u0001'
export const choiceValue = (c: ModelChoice) => `${c.providerId}${SEP}${c.model}`
export function parseChoiceValue(value: string): ModelChoice | undefined {
  const i = value.indexOf(SEP)
  return i > 0 ? { providerId: value.slice(0, i), model: value.slice(i + 1) } : undefined
}

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
const title = (s: string) => s[0].toUpperCase() + s.slice(1)

/** Aliases (with what the profile maps them to) plus the profile's default and extra model ids. */
function profileModelChoices(models: ProviderModels | undefined): { model: string; label: string }[] {
  const out: { model: string; label: string }[] = ALIASES.map((alias) => {
    const mapped = alias !== 'fable' ? models?.[alias] : undefined
    return { model: alias, label: mapped ? `${title(alias)} · ${mapped}` : title(alias) }
  })
  const seen = new Set<string>(ALIASES)
  for (const id of [models?.default, ...(models?.extra ?? [])]) {
    if (!id || seen.has(id)) continue
    out.push({ model: id, label: id === models?.default ? `${id} (padrão do perfil)` : id })
    seen.add(id)
  }
  return out
}

function tokenOption(profileId: string, m: PlatformModel): PickerOption {
  const context = formatContext(m.contextLength)
  const price = priceLabel(m)
  return {
    value: choiceValue({ providerId: profileId, model: m.id }),
    label: [m.name, context, price].filter(Boolean).join(' · '),
    title: [
      m.id,
      context && `${context} tokens de contexto`,
      price && `${price} tokens (entrada / saída; custo estimado, o oficial é o da plataforma)`
    ]
      .filter(Boolean)
      .join('\n'),
    choice: { providerId: profileId, model: m.id }
  }
}

/**
 * The model picker's groups: **Assinatura** (Claude Code's aliases), one **Modelos de token · <conexão>** per synced
 * connection (name, context, price) and **Outros perfis** (the user's own profiles and their models).
 */
export function pickerGroups(profiles: ProviderProfile[], models: PlatformModels): PickerGroup[] {
  const groups: PickerGroup[] = [
    {
      label: 'Assinatura',
      options: profileModelChoices(undefined).map((c) => ({
        value: choiceValue({ providerId: SUBSCRIPTION_PROFILE_ID, model: c.model }),
        label: c.label,
        choice: { providerId: SUBSCRIPTION_PROFILE_ID, model: c.model }
      }))
    }
  ]
  for (const p of profiles.filter((x) => x.managedBy === 'platform')) {
    const c = models.connections.find((x) => x.profileId === p.id)
    const fromProfile = [p.models?.default, ...(p.models?.extra ?? [])].filter((m): m is string => !!m)
    const list: PlatformModel[] = c?.models ?? fromProfile.map((id) => ({ id, name: id }))
    groups.push({
      label: `Modelos de token · ${c?.name ?? p.name.replace(/^Plataforma · /, '')}`,
      options: list.map((m) => tokenOption(p.id, m))
    })
  }
  const others = profiles.filter((p) => p.id !== SUBSCRIPTION_PROFILE_ID && p.managedBy !== 'platform')
  if (others.length)
    groups.push({
      label: 'Outros perfis',
      options: others.flatMap((p) =>
        profileModelChoices(p.models).map((c) => ({
          value: choiceValue({ providerId: p.id, model: c.model }),
          label: `${p.name} · ${c.label}`,
          choice: { providerId: p.id, model: c.model }
        }))
      )
    })
  return groups.filter((g) => g.options.length)
}

// ---------------------------------------------------------------- origin and estimated cost

export interface ModelOrigin {
  /** "Assinatura", "Token · <conexão>" or the profile's name. */
  label: string
  connection?: PlatformConnection
  model?: PlatformModel
}

export function modelOrigin(
  providerId: string | undefined,
  providerName: string | undefined,
  model: string | undefined,
  profiles: ProviderProfile[],
  models: PlatformModels
): ModelOrigin {
  const id = providerId ?? SUBSCRIPTION_PROFILE_ID
  if (id === SUBSCRIPTION_PROFILE_ID) return { label: 'Assinatura' }
  const connection = models.connections.find((c) => c.profileId === id)
  const profile = profiles.find((p) => p.id === id)
  if (connection || profile?.managedBy === 'platform') {
    const name = connection?.name ?? profile?.name.replace(/^Plataforma · /, '') ?? providerName ?? id
    return { label: `Token · ${name}`, connection, model: connection?.models.find((m) => m.id === model) }
  }
  return { label: profile?.name ?? providerName ?? id }
}

/** Cost of one turn at the platform's prices (all input tokens at the input price), when the model has them. */
export function estimateCost(
  m: PlatformModel | undefined,
  tokens: { input: number; output: number }
): number | undefined {
  if (!m || (m.priceInPerMTok === undefined && m.priceOutPerMTok === undefined)) return undefined
  return (tokens.input * (m.priceInPerMTok ?? 0) + tokens.output * (m.priceOutPerMTok ?? 0)) / 1_000_000
}
