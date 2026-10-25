// Connection indicator for the sidebar footer: avatar (or initial), company and state. Opens Settings → Plataforma.
import { useUi } from '../../core/ui'
import { statusLabel, usePlatform } from './api'
import { Avatar, StatusDot } from './parts'
import styles from './platform.module.css'

export function PlatformIndicator() {
  const state = usePlatform()
  if (!state || state.status === 'off') return null
  const connected = (state.status === 'connected' || state.status === 'error') && state.user
  const blocking = !state.canCreateSessions
  return (
    <div className={styles.indicatorWrap}>
      <button
        className={`${styles.indicator} ${blocking ? styles.indicatorBlocking : ''}`}
        onClick={() => useUi.getState().openSettings('platform')}
        title={
          connected
            ? `${state.user?.name} · ${state.user?.email}\n${state.org?.name ?? ''}\n${statusLabel(state)}`
            : 'Plataforma Agent Hangar: ver a conexão'
        }
      >
        {connected ? <Avatar user={state.user} size={22} /> : <span className={styles.indicatorIcon}>⌂</span>}
        <span className={styles.indicatorText}>
          <span className={styles.indicatorTitle}>
            {connected ? (state.org?.name ?? state.user?.name) : blocking ? 'Conectar à plataforma' : 'Plataforma'}
          </span>
          <span className={styles.indicatorSub}>
            {connected && state.org ? `${state.user?.name} · ${statusLabel(state)}` : statusLabel(state)}
          </span>
        </span>
        <StatusDot state={state} />
      </button>
    </div>
  )
}
