// First-run assistant: Boas-vindas → Diagnóstico → Provedor → Pasta inicial → Pronto.
// Shown full screen by App while settings.onboardingDone is false; "Pular" ends it from any step.
import { useEffect, useState } from 'react'
import type { ProviderSummary } from '@shared/features/onboarding'
import { api } from '../../core/api'
import { useSettings } from '../../core/data'
import { useUi } from '../../core/ui'
import { onboardingApi, useOnboardingNav, type OnboardingStep } from './api'
import { DiagnosticsPanel, Spinner } from './Diagnostics'
import styles from './onboarding.module.css'

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: 'welcome', label: 'Boas-vindas' },
  { id: 'diagnose', label: 'Diagnóstico' },
  { id: 'provider', label: 'Provedor' },
  { id: 'folder', label: 'Pasta inicial' },
  { id: 'done', label: 'Pronto' }
]

const KIND_LABEL: Record<string, string> = {
  subscription: 'Assinatura',
  anthropic: 'API Anthropic',
  gateway: 'Gateway',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry'
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

function formatAccelerator(acc: string): string {
  return acc
    .split('+')
    .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' ? 'Ctrl' : p === 'Super' ? 'Win' : p === 'Space' ? 'Espaço' : p))
    .join('+')
}

function Keys({ keys }: { keys: string }) {
  return (
    <span>
      {keys.split('+').map((k, i) => (
        <kbd key={i} className={styles.kbd}>
          {k}
        </kbd>
      ))}
    </span>
  )
}

const finish = () => api.patchSettings({ onboardingDone: true })

function Welcome() {
  return (
    <>
      <h1>Bem-vindo ao Hangar</h1>
      <p className={styles.lead}>
        Um app desktop para rodar e acompanhar sessões do Claude Code: chat com ferramentas, terminal, alterações do git, navegador e
        artifacts lado a lado. Em poucos passos vamos conferir se está tudo pronto.
      </p>
      <div className={styles.features}>
        <div className={styles.feature}>
          <strong>Sessões por pasta</strong>
          <span>Cada sessão trabalha numa pasta (ou num worktree isolado) e continua de onde parou.</span>
        </div>
        <div className={styles.feature}>
          <strong>Seu login do Claude Code</strong>
          <span>Usa a assinatura que você já tem no CLI, ou perfis de chave de API e gateways.</span>
        </div>
        <div className={styles.feature}>
          <strong>Diagnóstico</strong>
          <span>Detectamos problemas comuns, como um gateway no settings.json que quebra o login, e corrigimos com um clique.</span>
        </div>
      </div>
    </>
  )
}

function ProviderStep({ onOpenProviders }: { onOpenProviders: () => void }) {
  const [summary, setSummary] = useState<ProviderSummary>()
  useEffect(() => {
    void onboardingApi.providerSummary().then(setSummary)
  }, [])
  return (
    <>
      <h2>Provedor</h2>
      <p className={styles.lead}>Sessões novas usam o provedor padrão. Dá para trocar por sessão, na barra do chat.</p>
      {!summary ? (
        <div className={styles.loading}>
          <Spinner />
        </div>
      ) : (
        <div className={styles.summary}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{summary.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {summary.kind === 'subscription'
                ? 'Login do Claude Code (assinatura). Não precisa de chave.'
                : 'Perfil com credencial própria, guardada cifrada no Hangar.'}
              {summary.customProfiles ? ` ${summary.customProfiles} perfil(is) configurado(s).` : ''}
            </div>
          </div>
          <span className={styles.badge}>{KIND_LABEL[summary.kind] ?? summary.kind}</span>
        </div>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Quer usar uma chave de API da Anthropic, LiteLLM, OpenRouter, Bedrock, Vertex ou Foundry?{' '}
        <button className={styles.link} onClick={onOpenProviders}>
          Abrir Configurações → Provedores
        </button>{' '}
        (o assistente termina aqui).
      </p>
    </>
  )
}

function FolderStep() {
  const settings = useSettings()
  const [error, setError] = useState<string>()
  const pinned = settings?.pinnedFolders ?? []

  const pick = async () => {
    setError(undefined)
    const folder = await api.pickFolder(pinned[0])
    if (!folder || !settings) return
    try {
      await api.patchSettings({
        pinnedFolders: [folder, ...settings.pinnedFolders.filter((f) => !samePath(f, folder))],
        recentFolders: [folder, ...settings.recentFolders.filter((f) => !samePath(f, folder))].slice(0, 12)
      })
    } catch (err) {
      setError(String(err))
    }
  }

  const unpin = (folder: string) =>
    void api.patchSettings({ pinnedFolders: pinned.filter((f) => !samePath(f, folder)) })

  return (
    <>
      <h2>Pasta inicial</h2>
      <p className={styles.lead}>Escolha a pasta de um projeto para começar. Ela fica fixada no seletor de pastas de novas sessões e no Quick Entry.</p>
      {pinned.map((f) => (
        <div key={f} className={styles.summary}>
          <span>📌</span>
          <span className={styles.path} style={{ flex: 1 }}>
            {f}
          </span>
          <button className="btn" onClick={() => unpin(f)}>
            Desafixar
          </button>
        </div>
      ))}
      <button className={`btn ${pinned.length ? '' : 'btn-primary'}`} onClick={() => void pick()}>
        {pinned.length ? 'Fixar outra pasta…' : 'Escolher pasta…'}
      </button>
      {error && <div className={`${styles.notice} ${styles.noticeError}`}>{error}</div>}
    </>
  )
}

function DoneStep() {
  const settings = useSettings()
  const quick = settings?.quickEntryShortcut
  const rows: [string, string][] = [
    ['Paleta de comandos', 'Ctrl+K'],
    ['Nova sessão', 'Ctrl+N'],
    ['Configurações', 'Ctrl+,'],
    ['Terminal da sessão', 'Ctrl+`'],
    ...(quick ? ([['Quick Entry (de qualquer app)', formatAccelerator(quick)]] as [string, string][]) : [])
  ]
  return (
    <>
      <h1>Tudo pronto</h1>
      <p className={styles.lead}>Alguns atalhos e recursos para conhecer:</p>
      <table className={styles.shortcuts}>
        <tbody>
          {rows.map(([label, keys]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                <Keys keys={keys} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.features}>
        <div className={styles.feature}>
          <strong>Hangar Motion</strong>
          <span>Peça ao Claude uma animação ou vídeo curto: ele aparece em Artifacts, com player, editor e exportação para MP4.</span>
        </div>
        <div className={styles.feature}>
          <strong>Harness Lab</strong>
          <span>Na aba Harness do painel lateral, “Comparar variantes” testa versões do harness do projeto com seleção cega.</span>
        </div>
        <div className={styles.feature}>
          <strong>Diagnóstico de novo</strong>
          <span>Em Configurações → Geral, “Rodar diagnóstico” reabre esta verificação a qualquer momento.</span>
        </div>
      </div>
    </>
  )
}

export function OnboardingView() {
  const [step, setStep] = useState<OnboardingStep>(() => {
    const start = useOnboardingNav.getState().startStep
    useOnboardingNav.setState({ startStep: undefined })
    return start ?? 'welcome'
  })
  const index = STEPS.findIndex((s) => s.id === step)
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)].id)
  const back = () => setStep(STEPS[Math.max(index - 1, 0)].id)

  const openProviders = () => {
    useUi.getState().openSettings('providers')
    void finish()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) void finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.logo}>H</span>
          Hangar
          <span className={styles.spacer} />
          <button className="btn" onClick={() => void finish()} title="Fecha o assistente (Esc)">
            Pular
          </button>
        </div>

        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              className={`${styles.step} ${i === index ? styles.stepActive : i < index ? styles.stepDone : ''}`}
              onClick={() => setStep(s.id)}
            >
              {i < index ? '✓' : i + 1} {s.label}
            </button>
          ))}
        </div>

        <div className={styles.card}>
          {step === 'welcome' && <Welcome />}
          {step === 'diagnose' && (
            <>
              <h2>Diagnóstico</h2>
              <p className={styles.lead}>Conferimos o Claude Code, o login, gateways configurados, o provedor padrão e o git.</p>
              <DiagnosticsPanel onOpenProviders={openProviders} />
            </>
          )}
          {step === 'provider' && <ProviderStep onOpenProviders={openProviders} />}
          {step === 'folder' && <FolderStep />}
          {step === 'done' && <DoneStep />}
        </div>

        <div className={styles.footer}>
          {index > 0 && (
            <button className="btn" onClick={back}>
              Voltar
            </button>
          )}
          <span className={styles.spacer} />
          {step === 'done' ? (
            <button className="btn btn-primary" onClick={() => void finish()}>
              Começar a usar
            </button>
          ) : (
            <button className="btn btn-primary" onClick={next}>
              {step === 'welcome' ? 'Começar' : 'Próximo'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
