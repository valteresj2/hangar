import { useEffect, useState } from 'react'
import { UPDATER, type UpdaterState } from '@shared/features/updater'
import { api, bridge } from '../../core/api'
import styles from './updater.module.css'

function formatBytes(n: number): string {
  if (!n) return '0 MB'
  return `${(n / (1024 * 1024)).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''
}

function useUpdaterState(): UpdaterState | undefined {
  const [state, setState] = useState<UpdaterState>()
  useEffect(() => {
    let alive = true
    void bridge.invoke(UPDATER.state).then((s) => alive && setState(s))
    const off = bridge.on(UPDATER.evState, (s: UpdaterState) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

function StatusLine({ state }: { state: UpdaterState }) {
  switch (state.status) {
    case 'disabled':
      return <span className="muted">{state.disabledReason ?? 'Atualizações automáticas desativadas.'}</span>
    case 'idle':
      return <span className="muted">Ainda não verificado.</span>
    case 'checking':
      return <span>Procurando atualizações…</span>
    case 'not-available':
      return (
        <span>
          Você está na versão mais recente.
          {state.lastCheckedAt && <span className="muted"> Verificado em {formatTime(state.lastCheckedAt)}.</span>}
        </span>
      )
    case 'available':
      return (
        <span>
          Nova versão disponível: <strong>{state.availableVersion}</strong>
        </span>
      )
    case 'downloading':
      return <span>Baixando a versão {state.availableVersion}…</span>
    case 'downloaded':
      return (
        <span>
          Versão <strong>{state.availableVersion}</strong> pronta para instalar.
        </span>
      )
    case 'error':
      return <span className={styles.errorText}>{state.error}</span>
  }
}

/** Update status and actions (check, download, restart), mounted in Settings → Sobre. */
export function UpdaterPanel() {
  const state = useUpdaterState()
  const [busy, setBusy] = useState(false)

  if (!state) return null

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const disabled = state.status === 'disabled'
  const progress = state.progress

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Atualizações</div>
          <div className="muted">
            Versão atual <strong>{state.currentVersion}</strong> · canal {state.channel}
          </div>
        </div>
        <div className={styles.actions}>
          {state.status === 'available' && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => run(() => bridge.invoke(UPDATER.download))}
            >
              Baixar atualização
            </button>
          )}
          {state.status === 'downloaded' && (
            <button className="btn btn-primary" onClick={() => void bridge.invoke(UPDATER.install)}>
              Reiniciar e atualizar
            </button>
          )}
          <button
            className="btn"
            disabled={disabled || busy || state.status === 'checking' || state.status === 'downloading'}
            onClick={() => run(() => bridge.invoke(UPDATER.check))}
          >
            Verificar agora
          </button>
        </div>
      </div>

      <div className={styles.status}>
        <StatusLine state={state} />
      </div>

      {state.status === 'downloading' && (
        <div className={styles.progressBox}>
          <div className={styles.track}>
            <div className={styles.bar} style={{ width: `${Math.min(100, Math.max(0, progress?.percent ?? 0))}%` }} />
          </div>
          <div className="muted">
            {progress && progress.total > 0
              ? `${Math.floor(progress.percent)}% · ${formatBytes(progress.transferred)} de ${formatBytes(progress.total)} · ${formatBytes(progress.bytesPerSecond)}/s`
              : 'Iniciando download…'}
          </div>
        </div>
      )}

      {state.releaseNotes &&
        (state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') && (
          <details className={styles.notes}>
            <summary>Novidades da versão {state.availableVersion}</summary>
            <pre>{state.releaseNotes}</pre>
          </details>
        )}

      <label className={styles.option}>
        <input
          type="checkbox"
          checked={state.autoDownload}
          disabled={disabled}
          onChange={(e) => void bridge.invoke(UPDATER.setAutoDownload, e.target.checked)}
        />
        Baixar atualizações automaticamente em segundo plano
      </label>

      {state.status === 'error' && (
        <button className={`${styles.link} muted`} onClick={() => void api.openPath(state.logFile)}>
          Abrir log de atualização
        </button>
      )}
    </section>
  )
}
