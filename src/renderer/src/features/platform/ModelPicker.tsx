// The single model picker (composer, new session, Quick Entry, Configurações → Geral): one <select> grouped into
// Assinatura, Modelos de token · <conexão> and Outros perfis. Choosing yields a provider profile + model pair.
import { useMemo, useState } from 'react'
import type { ModelChoice } from '@shared/features/platform'
import type { ProviderProfile } from '@shared/providers'
import { choiceValue, parseChoiceValue, pickerGroups, usePlatformModels, useProviderProfiles } from './models'

const CUSTOM = '\u0000custom'

export interface ModelPickerProps {
  value: ModelChoice
  onChange(choice: ModelChoice): void
  /** Profiles to offer; loaded here when not given. */
  profiles?: ProviderProfile[]
  className?: string
  inputClassName?: string
  title?: string
  disabled?: boolean
  /** Only the current profile's models can be chosen (e.g. while a turn is running). */
  lockProvider?: boolean
  /** Adds "Outro modelo…": a model id typed by hand, on the current profile. */
  allowCustom?: boolean
}

export function ModelPicker({
  value,
  onChange,
  profiles: given,
  className,
  inputClassName,
  title = 'Modelo',
  disabled,
  lockProvider,
  allowCustom
}: ModelPickerProps) {
  const loaded = useProviderProfiles()
  const profiles = given ?? loaded
  const models = usePlatformModels()
  const groups = useMemo(() => pickerGroups(profiles, models), [profiles, models])
  const [custom, setCustom] = useState<string>()
  const current = choiceValue(value)
  const known = groups.some((g) => g.options.some((o) => o.value === current))
  const profile = profiles.find((p) => p.id === value.providerId)

  if (custom !== undefined)
    return (
      <input
        className={inputClassName ?? className}
        value={custom}
        autoFocus
        placeholder="id do modelo"
        title="Modelo (Enter aplica, Esc volta)"
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom.trim()) {
            onChange({ providerId: value.providerId, model: custom.trim() })
            setCustom(undefined)
          }
          if (e.key === 'Escape') setCustom(undefined)
        }}
        onBlur={() => {
          if (custom.trim() && custom.trim() !== value.model)
            onChange({ providerId: value.providerId, model: custom.trim() })
          setCustom(undefined)
        }}
      />
    )

  return (
    <select
      className={className}
      title={title}
      aria-label="Modelo"
      disabled={disabled}
      value={current}
      onChange={(e) => {
        if (e.target.value === CUSTOM) return setCustom('')
        const choice = parseChoiceValue(e.target.value)
        if (choice) onChange(choice)
      }}
    >
      {!known && (
        <option value={current}>
          {value.model}
          {profile ? ` · ${profile.name}` : profiles.length ? ' · perfil não encontrado' : ''}
        </option>
      )}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option
              key={o.value}
              value={o.value}
              title={o.title}
              disabled={lockProvider && o.choice.providerId !== value.providerId}
            >
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
      {allowCustom && <option value={CUSTOM}>Outro modelo…</option>}
    </select>
  )
}
