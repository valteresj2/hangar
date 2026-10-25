// One-click fix shown in the engine's provider error card: when the gateway in ~/.claude/settings.json breaks
// the subscription login, switch the session to "Assinatura (direto)".
import { useState } from 'react'
import type { DiagnosticReport, DirectFixResult } from '@shared/features/onboarding'
import { ENGINE } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { useRow } from '../../core/data'
import { errorText, onboardingApi, openDiagnostics } from './api'
import { Spinner } from './Diagnostics'
import styles from './onboarding.module.css'

export function GatewayFixButton({ sessionId }: { sessionId: string }) {
  const session = useRow('sessions', sessionId)
  const [report, setReport] = useState<DiagnosticReport>()
  const [fix, setFix] = useState<DirectFixResult>()
  const [busy, setBusy] = useState<'diagnose' | 'fix'>()
  const [error, setError] = useState<string>()

  const diagnose = async () => {
    setBusy('diagnose')
    setError(undefined)
    setFix(undefined)
    try {
      setReport(await onboardingApi.diagnose({ quick: true, providerId: session?.providerId }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(undefined)
    }
  }

  const apply = async () => {
    setBusy('fix')
    setError(undefined)
    try {
      const res = await onboardingApi.applyDirectFix()
      if (res.ok && res.profileId) await bridge.invoke(ENGINE.setProvider, sessionId, res.profileId)
      setFix(res)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(undefined)
    }
  }

  const provider = report?.items.find((i) => i.id === 'provider')
  const direct = report?.items.find((i) => i.id === 'direct')

  return (
    <div className={styles.fix}>
      {!fix && (
        <div className={styles.fixRow}>
          {report?.fixAvailable ? (
            <button className="btn btn-primary" disabled={!!busy} onClick={() => void apply()}>
              Usar assinatura direta
            </button>
          ) : (
            <button className="btn" disabled={!!busy} onClick={() => void diagnose()}>
              {report ? 'Diagnosticar de novo' : 'Diagnosticar gateway'}
            </button>
          )}
          {busy && <Spinner />}
          {busy === 'diagnose' && <span className="muted">Testando o provedor e a conexão direta…</span>}
          {busy === 'fix' && <span className="muted">Criando “Assinatura (direto)”…</span>}
        </div>
      )}

      {report && !fix && (
        <div className={styles.fixText}>
          {report.fixAvailable
            ? direct?.message
            : provider?.status === 'ok'
              ? `O provedor respondeu agora (${provider.message}) Tente reenviar a mensagem.`
              : report.gateway.isGateway
                ? `${direct?.message ?? provider?.message ?? ''}`
                : `Nenhum gateway configurado; o problema é outro. ${provider?.message ?? ''}`}{' '}
          {!report.fixAvailable && (
            <button className={styles.link} onClick={openDiagnostics}>
              Diagnóstico completo
            </button>
          )}
        </div>
      )}

      {fix && (
        <div className={styles.fixText}>
          {fix.ok
            ? `Pronto: esta sessão agora usa “${fix.profileName}”, que também virou o provedor padrão. ${
                fix.testOk === false ? fix.message : 'Reenvie a mensagem para continuar.'
              }`
            : fix.message}
        </div>
      )}
      {error && (
        <div className={styles.fixText} style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
