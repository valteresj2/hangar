// Diagnosis step: runs onboarding:diagnose, lists the checks and offers their actions.
import { useCallback, useEffect, useState } from 'react'
import type { DiagnosticAction, DiagnosticItem, DiagnosticReport, DirectFixResult } from '@shared/features/onboarding'
import { api } from '../../core/api'
import { errorText, onboardingApi } from './api'
import styles from './onboarding.module.css'

const ICON = { ok: '✓', warn: '!', error: '✕', skip: '–' } as const

export function Spinner() {
  return <span className={styles.spinner} aria-label="Carregando" />
}

function CheckRow({
  item,
  onAction,
  busy
}: {
  item: DiagnosticItem
  onAction: (a: DiagnosticAction) => void
  busy: boolean
}) {
  const tone =
    item.status === 'ok'
      ? styles.ok
      : item.status === 'warn'
        ? styles.warn
        : item.status === 'error'
          ? styles.error
          : ''
  return (
    <div className={styles.check}>
      <span className={`${styles.icon} ${tone}`}>{ICON[item.status]}</span>
      <div className={styles.checkBody}>
        <div className={styles.checkTitle}>{item.title}</div>
        <div className={styles.checkMessage}>{item.message}</div>
        {item.detail && <div className={styles.checkDetail}>{item.detail}</div>}
        {item.action && (
          <div className={styles.checkAction}>
            <button
              className={`btn ${item.action.kind === 'applyDirectFix' ? 'btn-primary' : ''}`}
              disabled={busy}
              onClick={() => onAction(item.action!)}
            >
              {item.action.label}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function DiagnosticsPanel({ onOpenProviders }: { onOpenProviders: () => void }) {
  const [report, setReport] = useState<DiagnosticReport>()
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fix, setFix] = useState<DirectFixResult>()
  const [error, setError] = useState<string>()

  const run = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      setReport(await onboardingApi.diagnose())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  const applyFix = async () => {
    setFixing(true)
    setFix(undefined)
    try {
      const res = await onboardingApi.applyDirectFix()
      setFix(res)
      if (res.ok) await run()
    } catch (err) {
      setFix({ ok: false, message: errorText(err) })
    } finally {
      setFixing(false)
    }
  }

  const onAction = (a: DiagnosticAction) => {
    if (a.kind === 'applyDirectFix') void applyFix()
    else if (a.kind === 'openProviders') onOpenProviders()
    else void api.openExternal(a.url)
  }

  const problems = report?.items.filter((i) => i.status === 'error').length ?? 0

  return (
    <>
      <div className={styles.footer} style={{ marginBottom: 12 }}>
        <span className="muted" style={{ flex: 1 }}>
          {running
            ? 'Verificando o Claude Code, o login, o gateway e o provedor (inclui uma consulta curta de teste)…'
            : report
              ? problems
                ? `${problems} problema${problems > 1 ? 's' : ''} encontrado${problems > 1 ? 's' : ''}.`
                : 'Tudo certo para começar.'
              : ''}
        </span>
        <button className="btn" disabled={running || fixing} onClick={() => void run()}>
          {running ? 'Verificando…' : 'Rodar de novo'}
        </button>
      </div>

      {error && <div className={`${styles.notice} ${styles.noticeError}`}>{error}</div>}

      {running && !report && (
        <div className={styles.loading}>
          <Spinner /> Rodando o diagnóstico…
        </div>
      )}

      {report && (
        <div className={styles.checks} style={{ opacity: running ? 0.6 : 1 }}>
          {report.items.map((item) => (
            <CheckRow key={item.id} item={item} busy={running || fixing} onAction={onAction} />
          ))}
        </div>
      )}

      {fixing && (
        <div className={styles.loading}>
          <Spinner /> Criando o perfil “Assinatura (direto)” e testando…
        </div>
      )}
      {fix && (
        <div className={`${styles.notice} ${fix.ok && fix.testOk !== false ? styles.noticeOk : styles.noticeError}`}>
          {fix.message}
        </div>
      )}
    </>
  )
}
