import { useCallback, useEffect, useState } from 'react'
import { SETTINGS, type ProviderInput, type ProvidersState, type ProviderTestResult } from '@shared/features/settings'
import { SUBSCRIPTION_PROFILE_ID, type ProviderKind, type ProviderProfile } from '@shared/providers'
import { api, bridge } from '../../../core/api'
import { errorText, settingsApi } from '../api'
import { Card, Segmented, Spinner } from '../ui'
import styles from '../settings.module.css'

export const KIND_LABEL: Record<ProviderKind, string> = {
  subscription: 'Assinatura',
  anthropic: 'API Anthropic',
  gateway: 'Gateway',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry'
}

const DOCS: Record<ProviderKind, string> = {
  subscription: 'https://code.claude.com/docs/en/authentication',
  anthropic: 'https://code.claude.com/docs/en/env-vars',
  gateway: 'https://code.claude.com/docs/en/llm-gateway-connect',
  bedrock: 'https://code.claude.com/docs/en/amazon-bedrock',
  vertex: 'https://code.claude.com/docs/en/google-vertex-ai',
  foundry: 'https://code.claude.com/docs/en/microsoft-foundry'
}

const BETAS_VAR = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'

interface Template {
  key: string
  label: string
  help: string
  doc: string
  input: ProviderInput
}

const TEMPLATES: Template[] = [
  {
    key: 'subscription-direct',
    label: 'Assinatura (direto, sem gateway)',
    help: 'Usa o login da sua assinatura do Claude Code, mas fala direto com a Anthropic (ou com a URL que você informar), ignorando um ANTHROPIC_BASE_URL do ~/.claude/settings.json. Útil quando o gateway configurado lá está fora do ar.',
    doc: DOCS.subscription,
    input: { name: 'Assinatura (direto)', kind: 'subscription', baseUrl: 'https://api.anthropic.com' }
  },
  {
    key: 'anthropic',
    label: 'Anthropic (chave de API)',
    help: 'Chave do Console da Anthropic (sk-ant-…). Cobra por token na conta da API, não usa a assinatura.',
    doc: DOCS.anthropic,
    input: { name: 'Anthropic API', kind: 'anthropic' }
  },
  {
    key: 'litellm',
    label: 'LiteLLM (proxy local)',
    help:
      'Proxy LiteLLM rodando nesta máquina. O token é a master key ou uma virtual key do proxy; os modelos são os model_name do config.yaml ' +
      '(podem apontar para GPT, Gemini e outros).',
    doc: 'https://docs.litellm.ai/docs/tutorials/claude_responses_api',
    input: { name: 'LiteLLM', kind: 'gateway', baseUrl: 'http://localhost:4000', authStyle: 'bearer' }
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    help: 'Chave do OpenRouter enviada como Bearer. Modelos no formato provedor/modelo (ex.: anthropic/claude-sonnet-4.6).',
    doc: 'https://openrouter.ai/docs/guides/guides/claude-code-integration',
    input: { name: 'OpenRouter', kind: 'gateway', baseUrl: 'https://openrouter.ai/api', authStyle: 'bearer' }
  },
  {
    key: 'gateway',
    label: 'Gateway personalizado',
    help: 'Qualquer gateway compatível com a API de Mensagens da Anthropic (corporativo, proxy próprio…). A URL base vai sem /v1.',
    doc: DOCS.gateway,
    input: { name: 'Gateway', kind: 'gateway', authStyle: 'bearer' }
  },
  {
    key: 'bedrock',
    label: 'Amazon Bedrock',
    help: 'Usa as credenciais da AWS (perfil do aws configure / aws sso login) ou uma chave de API do Bedrock.',
    doc: DOCS.bedrock,
    input: { name: 'Amazon Bedrock', kind: 'bedrock', region: 'us-east-1' }
  },
  {
    key: 'vertex',
    label: 'Google Vertex AI',
    help:
      'Usa as credenciais do Google Cloud (gcloud auth application-default login). Para chave de conta de serviço, ' +
      'adicione GOOGLE_APPLICATION_CREDENTIALS em variáveis extras.',
    doc: DOCS.vertex,
    input: { name: 'Google Vertex AI', kind: 'vertex', region: 'global' }
  },
  {
    key: 'foundry',
    label: 'Microsoft Foundry',
    help: 'Nome do recurso Azure e os nomes dos deployments como modelos. Sem chave, usa o login do Azure (az login).',
    doc: DOCS.foundry,
    input: { name: 'Microsoft Foundry', kind: 'foundry', authStyle: 'x-api-key' }
  }
]

const SECRET_LABEL: Partial<Record<ProviderKind, string>> = {
  anthropic: 'Chave da API',
  gateway: 'Token / chave',
  bedrock: 'Chave de API do Bedrock (opcional)',
  foundry: 'Chave ou token (opcional)'
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

const formatEnv = (env: Record<string, string> | undefined) =>
  Object.entries(env ?? {})
    .filter(([k]) => k !== BETAS_VAR)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

function ProviderForm({
  initial,
  existing,
  help,
  doc,
  encryptionAvailable,
  onClose
}: {
  initial: ProviderInput
  existing?: ProviderProfile
  help?: string
  doc: string
  encryptionAvailable: boolean
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ProviderInput>(initial)
  const [secret, setSecret] = useState('')
  const [extra, setExtra] = useState(formatEnv(initial.extraEnv))
  const [extraModels, setExtraModels] = useState((initial.models?.extra ?? []).join('\n'))
  const [betasOff, setBetasOff] = useState(initial.extraEnv?.[BETAS_VAR] === '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hasSecret, setHasSecret] = useState(!!existing?.hasSecret)
  const set = (patch: Partial<ProviderInput>) => setDraft((d) => ({ ...d, ...patch }))
  const setModel = (key: 'default' | 'opus' | 'sonnet' | 'haiku', value: string) =>
    set({ models: { ...draft.models, [key]: value } })
  const kind = draft.kind
  const secretLabel = SECRET_LABEL[kind]

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const extraEnv = parseEnv(extra)
      if (betasOff) extraEnv[BETAS_VAR] = '1'
      const models = {
        ...draft.models,
        extra: extraModels
          .split(/[\n,]/)
          .map((m) => m.trim())
          .filter(Boolean)
      }
      const saved = await settingsApi.saveProvider({ ...draft, extraEnv, models })
      if (secret.trim()) {
        try {
          await settingsApi.setProviderSecret(saved.id, secret)
        } catch (err) {
          setSecret('')
          setDraft((d) => ({ ...d, id: saved.id }))
          return setError(`Perfil salvo, mas a chave não: ${errorText(err)}`)
        }
      }
      setSecret('')
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const clearSecret = async () => {
    if (!existing || !window.confirm('Remover a chave salva deste perfil?')) return
    try {
      await settingsApi.clearProviderSecret(existing.id)
      setHasSecret(false)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Card title={existing ? `Editar “${existing.name}”` : `Novo perfil · ${KIND_LABEL[kind]}`}>
      <div className={styles.form}>
        {help && (
          <div className={`${styles.formFull} ${styles.hint}`}>
            {help}{' '}
            <button className={styles.link} onClick={() => void api.openExternal(doc)}>
              Documentação
            </button>
          </div>
        )}

        <label>Nome</label>
        <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />

        {(kind === 'subscription' ||
          kind === 'gateway' ||
          kind === 'anthropic' ||
          kind === 'bedrock' ||
          kind === 'vertex' ||
          kind === 'foundry') && (
          <>
            <label>{kind === 'gateway' ? 'URL base' : 'URL base (opcional)'}</label>
            <input
              className="input"
              value={draft.baseUrl ?? ''}
              placeholder={
                kind === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : kind === 'gateway'
                    ? 'https://llm-gateway.exemplo.com'
                    : kind === 'foundry'
                      ? 'https://<recurso>.services.ai.azure.com/anthropic'
                      : 'endpoint próprio ou gateway'
              }
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </>
        )}

        {kind === 'gateway' && (
          <>
            <label>Autenticação</label>
            <div>
              <Segmented
                value={draft.authStyle ?? 'bearer'}
                onChange={(authStyle) => set({ authStyle })}
                options={[
                  { value: 'bearer', label: 'Authorization: Bearer' },
                  { value: 'x-api-key', label: 'x-api-key' }
                ]}
              />
            </div>
          </>
        )}
        {kind === 'foundry' && (
          <>
            <label>Recurso</label>
            <input
              className="input"
              value={draft.project ?? ''}
              placeholder="my-resource"
              onChange={(e) => set({ project: e.target.value })}
            />
            <label>Tipo de credencial</label>
            <div>
              <Segmented
                value={draft.authStyle ?? 'x-api-key'}
                onChange={(authStyle) => set({ authStyle })}
                options={[
                  { value: 'x-api-key', label: 'Chave da API' },
                  { value: 'bearer', label: 'Token Entra (Bearer)' }
                ]}
              />
            </div>
          </>
        )}
        {kind === 'bedrock' && (
          <>
            <label>Região AWS</label>
            <input
              className="input"
              value={draft.region ?? ''}
              placeholder="us-east-1"
              onChange={(e) => set({ region: e.target.value })}
            />
            <label>Perfil AWS (opcional)</label>
            <input
              className="input"
              value={draft.awsProfile ?? ''}
              placeholder="default"
              onChange={(e) => set({ awsProfile: e.target.value })}
            />
          </>
        )}
        {kind === 'vertex' && (
          <>
            <label>Projeto GCP</label>
            <input
              className="input"
              value={draft.project ?? ''}
              placeholder="meu-projeto"
              onChange={(e) => set({ project: e.target.value })}
            />
            <label>Região</label>
            <input
              className="input"
              value={draft.region ?? ''}
              placeholder="global, us-east5…"
              onChange={(e) => set({ region: e.target.value })}
            />
          </>
        )}

        {secretLabel && (
          <>
            <label>{secretLabel}</label>
            <div className={styles.inline}>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                disabled={!encryptionAvailable}
                placeholder={
                  !encryptionAvailable
                    ? 'Criptografia do sistema indisponível'
                    : hasSecret
                      ? '•••• salva — digite para substituir'
                      : 'Cole a chave'
                }
                onChange={(e) => setSecret(e.target.value)}
              />
              {hasSecret && (
                <button className="btn" onClick={() => void clearSecret()}>
                  Remover chave
                </button>
              )}
            </div>
          </>
        )}

        <div className={`${styles.formFull} ${styles.cardTitle}`} style={{ padding: '6px 0 0' }}>
          Modelos
        </div>
        <div className={`${styles.formFull} ${styles.hint}`}>
          Vazio = padrão do Claude Code.{' '}
          {kind === 'gateway' &&
            'Via LiteLLM/OpenRouter os nomes podem ser de outros fabricantes (ex.: um GPT ou Gemini configurado no proxy). '}
          {kind === 'foundry' && 'Use os nomes dos deployments. '}
          {(kind === 'gateway' || kind === 'foundry') && (
            <strong>
              Modelos que não são Claude podem não suportar bem ferramentas, thinking ou imagens no Claude Code.
            </strong>
          )}
        </div>
        <label>Padrão</label>
        <input
          className="input"
          value={draft.models?.default ?? ''}
          placeholder="usado quando a sessão não escolhe modelo"
          onChange={(e) => setModel('default', e.target.value)}
        />
        <label>opus →</label>
        <input
          className="input"
          value={draft.models?.opus ?? ''}
          placeholder="ANTHROPIC_DEFAULT_OPUS_MODEL"
          onChange={(e) => setModel('opus', e.target.value)}
        />
        <label>sonnet →</label>
        <input
          className="input"
          value={draft.models?.sonnet ?? ''}
          placeholder="ANTHROPIC_DEFAULT_SONNET_MODEL"
          onChange={(e) => setModel('sonnet', e.target.value)}
        />
        <label>haiku →</label>
        <input
          className="input"
          value={draft.models?.haiku ?? ''}
          placeholder="ANTHROPIC_DEFAULT_HAIKU_MODEL"
          onChange={(e) => setModel('haiku', e.target.value)}
        />
        <label style={{ alignSelf: 'start', paddingTop: 6 }}>Extras</label>
        <textarea
          className="input"
          value={extraModels}
          placeholder="um modelo por linha (aparecem no seletor do chat)"
          onChange={(e) => setExtraModels(e.target.value)}
        />

        {kind === 'gateway' && (
          <>
            <label>Compatibilidade</label>
            <label className={styles.inline} style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={betasOff} onChange={(e) => setBetasOff(e.target.checked)} />
              Desligar betas experimentais ({BETAS_VAR}=1) — use se o gateway responder “Extra inputs are not permitted”
            </label>
          </>
        )}

        <label style={{ alignSelf: 'start', paddingTop: 6 }}>Variáveis extras</label>
        <textarea
          className="input"
          value={extra}
          placeholder="NOME=valor (uma por linha; nada de segredos aqui — elas ficam em texto)"
          onChange={(e) => setExtra(e.target.value)}
        />

        {error && <div className={`${styles.formFull} ${styles.errorText}`}>{error}</div>}
        <div className={styles.formActions}>
          {busy && <Spinner />}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => void submit()}>
            Salvar
          </button>
        </div>
      </div>
    </Card>
  )
}

function ProviderItem({
  profile,
  isDefault,
  userBaseUrl,
  onEdit
}: {
  profile: ProviderProfile
  isDefault: boolean
  userBaseUrl?: string
  onEdit: () => void
}) {
  const [test, setTest] = useState<ProviderTestResult>()
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string>()
  const builtIn = profile.id === SUBSCRIPTION_PROFILE_ID

  const runTest = async () => {
    setTesting(true)
    setTest(undefined)
    setError(undefined)
    try {
      setTest(await settingsApi.testProvider(profile.id))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setTesting(false)
    }
  }

  const act = (fn: () => Promise<unknown>) => () => {
    setError(undefined)
    fn().catch((err) => setError(errorText(err)))
  }

  const remove = act(async () => {
    if (window.confirm(`Excluir o perfil “${profile.name}”? A chave salva também é apagada.`))
      await settingsApi.deleteProvider(profile.id)
  })

  return (
    <div className={styles.item}>
      <div className={styles.itemMain}>
        <div className={styles.itemTitle}>
          {profile.name}
          <span className={styles.badge}>{KIND_LABEL[profile.kind]}</span>
          {isDefault && <span className={`${styles.badge} ${styles.okText}`}>padrão</span>}
          {profile.hasSecret && <span className={styles.badge}>chave salva</span>}
        </div>
        <div className={`${styles.itemSub} ${styles.path}`}>
          {builtIn
            ? `Login do Claude Code e o seu ~/.claude/settings.json, sem mudanças${userBaseUrl ? ` (inclusive ANTHROPIC_BASE_URL = ${userBaseUrl})` : ''}.`
            : [
                profile.baseUrl ?? (profile.kind === 'anthropic' ? 'https://api.anthropic.com' : undefined),
                profile.project,
                profile.region,
                profile.awsProfile && `perfil AWS ${profile.awsProfile}`,
                profile.models?.default && `modelo ${profile.models.default}`
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
        </div>
        {testing && <div className={styles.hint}>Testando (uma consulta curta pelo Claude Code)…</div>}
        {test &&
          (test.ok ? (
            <div className={`${styles.hint} ${styles.okText}`}>
              ✓ Respondeu “{test.reply}” · modelo {test.model} · {(test.latencyMs / 1000).toFixed(1)} s
            </div>
          ) : (
            <div className={styles.errorText} style={{ fontSize: 12 }}>
              ✗ {test.error} {test.model ? `(modelo ${test.model})` : ''}
            </div>
          ))}
        {error && <div className={styles.errorText}>{error}</div>}
      </div>
      <div className={`${styles.itemActions} ${styles.mcpActions}`}>
        {testing && <Spinner />}
        <button className="btn" disabled={testing} onClick={() => void runTest()}>
          Testar
        </button>
        {!isDefault && (
          <button className="btn" onClick={act(() => settingsApi.setDefaultProvider(profile.id))}>
            Definir como padrão
          </button>
        )}
        {!builtIn && (
          <>
            <button className="btn" onClick={onEdit}>
              Editar
            </button>
            <button className={`btn ${styles.btnDanger}`} onClick={remove}>
              Excluir
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function useProvidersState(): ProvidersState | undefined {
  const [state, setState] = useState<ProvidersState>()
  const load = useCallback(() => void settingsApi.providers().then(setState), [])
  useEffect(() => {
    load()
    return bridge.on(SETTINGS.providersChanged, load)
  }, [load])
  return state
}

type Editing = { template?: Template; profile?: ProviderProfile }

export function ProvidersSection() {
  const state = useProvidersState()
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<Editing>()

  if (!state) return <Spinner />

  const startTemplate = (template: Template) => {
    setPicking(false)
    setEditing({ template })
  }

  return (
    <>
      <div className={styles.toolbar}>
        <span className="muted" style={{ flex: 1 }}>
          Por padrão o Hangar usa o login do Claude Code (assinatura). Perfis permitem usar chave de API, gateways
          (LiteLLM, OpenRouter…), Bedrock, Vertex ou Foundry. As chaves ficam cifradas pelo sistema e nunca voltam para
          a tela.
        </span>
        {!editing && (
          <button className="btn btn-primary" onClick={() => setPicking((v) => !v)}>
            Novo perfil
          </button>
        )}
      </div>

      {!state.encryptionAvailable && (
        <Card>
          <div className={styles.row}>
            <span className={styles.errorText}>
              A criptografia do sistema (safeStorage/DPAPI) não está disponível. Você pode criar perfis, mas o Hangar
              não salva chaves.
            </span>
          </div>
        </Card>
      )}

      {picking && (
        <Card title="Escolha um modelo de perfil">
          <div className={styles.list}>
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                className={styles.item}
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => startTemplate(t)}
              >
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{t.label}</div>
                  <div className={styles.itemSub}>{t.help}</div>
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {editing && (
        <ProviderForm
          key={editing.profile?.id ?? editing.template?.key}
          initial={editing.profile ? { ...editing.profile } : editing.template!.input}
          existing={editing.profile}
          help={editing.template?.help ?? TEMPLATES.find((t) => t.input.kind === editing.profile?.kind)?.help}
          doc={editing.template?.doc ?? DOCS[editing.profile?.kind ?? 'gateway']}
          encryptionAvailable={state.encryptionAvailable}
          onClose={() => setEditing(undefined)}
        />
      )}

      <Card title="Perfis">
        <div className={styles.list}>
          {state.profiles.map((p) => (
            <ProviderItem
              key={p.id}
              profile={p}
              isDefault={p.id === state.defaultId}
              userBaseUrl={state.userSettingsBaseUrl}
              onEdit={() => setEditing({ profile: p })}
            />
          ))}
        </div>
      </Card>
    </>
  )
}
