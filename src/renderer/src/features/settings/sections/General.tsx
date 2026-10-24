import { useCallback, useEffect, useState } from 'react'
import type { Effort, PermissionMode, Settings, ThemePref } from '@shared/contracts'
import type { AuthStatus, CliInfo } from '@shared/features/settings'
import { api } from '../../../core/api'
import { useSettings } from '../../../core/data'
import { openDiagnostics } from '../../onboarding'
import { settingsApi } from '../api'
import { Card, Dot, Row, Segmented, Spinner, Switch } from '../ui'
import { useSettingsSection } from '../SettingsView'
import { KIND_LABEL, useProvidersState } from './Providers'
import { TrayQuickEntryCard } from './TrayQuickEntry'
import styles from '../settings.module.css'

export const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']

export const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Baixo' },
  { value: 'medium', label: 'Médio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muito alto' },
  { value: 'max', label: 'Máximo' }
]

export const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Perguntar' },
  { value: 'acceptEdits', label: 'Aceitar edições' },
  { value: 'plan', label: 'Planejar' },
  { value: 'auto', label: 'Automático' },
  { value: 'bypassPermissions', label: 'Ignorar permissões' }
]

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' }
]

/** Text input that saves on blur / Enter instead of on every keystroke. */
function LazyInput({
  value,
  onCommit,
  placeholder,
  list
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  list?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const commit = () => draft !== value && onCommit(draft)
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

function CliCard({ settings }: { settings: Settings }) {
  const [info, setInfo] = useState<CliInfo>()
  const [auth, setAuth] = useState<AuthStatus>()
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const i = await settingsApi.cliInfo()
      setInfo(i)
      setAuth(i.path && !i.error ? await settingsApi.authStatus() : undefined)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void refresh(), [refresh, settings.claudeExecutablePath])

  const setPath = (path: string | undefined) => void api.patchSettings({ claudeExecutablePath: path?.trim() || undefined })

  const browse = async () => {
    const file = await settingsApi.pickFile(info?.path)
    if (file) setPath(file)
  }

  return (
    <Card
      title="Claude Code"
      actions={
        <>
          {/* Reopens the first-run assistant on its diagnosis step (onboarding feature). */}
          <button className="btn" title="Verifica executável, login, gateway, provedor e git" onClick={openDiagnostics}>
            Rodar diagnóstico
          </button>
          {loading ? <Spinner /> : <button className="btn" onClick={() => void refresh()}>Verificar</button>}
        </>
      }
    >
      <Row
        label="Executável do claude"
        hint={
          info?.path && !settings.claudeExecutablePath ? (
            <>
              Detectado no PATH: <span className={styles.path}>{info.path}</span>
            </>
          ) : (
            'Deixe vazio para detectar automaticamente no PATH.'
          )
        }
      >
        <LazyInput value={settings.claudeExecutablePath ?? ''} placeholder={info?.path ?? 'claude'} onCommit={setPath} />
        <button className="btn" onClick={() => void browse()}>
          Procurar…
        </button>
        {settings.claudeExecutablePath && (
          <button className="btn" onClick={() => setPath(undefined)}>
            Detectar
          </button>
        )}
      </Row>
      <Row label="Versão">
        {info?.version ? (
          <span>{info.version}</span>
        ) : info?.error ? (
          <span className={styles.errorText}>{info.error}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
      <Row
        label="Login"
        hint={
          auth && !auth.loggedIn
            ? 'Abra um terminal, rode `claude` e use /login para entrar com sua assinatura.'
            : auth?.email
              ? `${auth.email}${auth.orgName ? ` · ${auth.orgName}` : ''}`
              : undefined
        }
      >
        {!auth ? (
          <span className="muted">—</span>
        ) : auth.loggedIn ? (
          <span className={styles.inline}>
            <Dot tone="ok" />
            {auth.authMethod === 'claude.ai'
              ? `Conectado com a assinatura${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}`
              : `Conectado (${auth.authMethod ?? 'credencial'})`}
          </span>
        ) : (
          <span className={styles.inline}>
            <Dot tone="bad" />
            {auth.error ? 'Status indisponível' : 'Não conectado'}
          </span>
        )}
      </Row>
      <DefaultProviderRow />
    </Card>
  )
}

/** Which provider profile new sessions use; the login above only matters for the subscription profile. */
function DefaultProviderRow() {
  const state = useProvidersState()
  const setSection = useSettingsSection((s) => s.setSection)
  const current = state?.profiles.find((p) => p.id === state.defaultId)
  return (
    <Row
      label="Provedor padrão"
      hint={
        current && current.kind !== 'subscription'
          ? 'Sessões sem provedor próprio usam este perfil; o login acima só vale para o perfil da assinatura.'
          : 'Sessões usam o login acima (assinatura) e o seu ~/.claude/settings.json.'
      }
    >
      <span>{current ? `${current.name} · ${KIND_LABEL[current.kind]}` : '—'}</span>
      <button className="btn" onClick={() => setSection('providers')}>
        Provedores
      </button>
    </Row>
  )
}

export function GeneralSection() {
  const settings = useSettings()
  if (!settings) return <Spinner />
  const patch = (p: Partial<Settings>) => void api.patchSettings(p)

  return (
    <>
      <Card title="Aparência">
        <Row label="Tema" hint="Sistema acompanha o tema do Windows.">
          <Segmented value={settings.theme} options={THEMES} onChange={(theme) => patch({ theme })} />
        </Row>
      </Card>

      <Card title="Notificações">
        <Row label="Notificar quando uma sessão terminar ou precisar de você" hint="Só aparecem com a janela do Hangar fora de foco.">
          <button className="btn" onClick={() => void settingsApi.testNotification()}>
            Testar
          </button>
          <Switch label="Notificações" checked={settings.notifications} onChange={(notifications) => patch({ notifications })} />
        </Row>
      </Card>

      <TrayQuickEntryCard settings={settings} />

      <Card title="Padrões de novas sessões">
        <Row label="Modelo" hint="Alias (opus, sonnet…) ou id completo do modelo.">
          <LazyInput value={settings.defaultModel} list="hangar-models" onCommit={(v) => v.trim() && patch({ defaultModel: v.trim() })} />
          <datalist id="hangar-models">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Row>
        <Row label="Esforço">
          <select className={styles.select} value={settings.defaultEffort} onChange={(e) => patch({ defaultEffort: e.target.value as Effort })}>
            {EFFORTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Modo de permissão">
          <select
            className={styles.select}
            value={settings.defaultPermissionMode}
            onChange={(e) => patch({ defaultPermissionMode: e.target.value as PermissionMode })}
          >
            {PERMISSION_MODES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      </Card>

      <CliCard settings={settings} />
    </>
  )
}
