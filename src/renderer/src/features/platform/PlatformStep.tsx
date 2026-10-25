// Onboarding step "Conectar à plataforma": skippable in hybrid mode, mandatory when the mode is `required`.
import { useState } from 'react'
import type { PlatformState } from '@shared/features/platform'
import { Spinner } from '../settings/ui'
import { statusLabel, usePlatform } from './api'
import { Avatar, ConnectButtons, StatusDot, UrlField } from './parts'
import { NoticeBanner } from './PlatformSection'
import styles from './platform.module.css'

/** Whether the onboarding shows the step at all (hidden when the platform is off). */
export function platformStepVisible(state: PlatformState | undefined): boolean {
  return !!state && state.config.mode !== 'off'
}

/** Whether the onboarding must stop at the step (mode `required` and not connected). */
export function platformStepBlocking(state: PlatformState | undefined): boolean {
  return !!state && !state.canCreateSessions
}

export function PlatformStep() {
  const state = usePlatform()
  const [error, setError] = useState<string>()
  if (!state) return <Spinner />
  const required = state.config.mode === 'required'
  const connected = state.status === 'connected' || state.status === 'error'
  const shownError = error ?? state.error

  return (
    <>
      <h2>Conectar à plataforma</h2>
      <p className={styles.lead}>
        {required
          ? 'Sua empresa exige que o Hangar esteja conectado ao Agent Hangar para criar sessões. Entre com a sua conta corporativa no navegador.'
          : 'Se a sua empresa usa o Agent Hangar, conecte para entrar com a conta corporativa. É opcional: dá para conectar depois em Configurações → Plataforma.'}
      </p>
      <NoticeBanner state={state} />
      {connected && state.user ? (
        <div className={styles.stepCard}>
          <Avatar user={state.user} size={36} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className={styles.accountName}>{state.user.name}</span>
            <span className={styles.accountEmail}>
              {state.org?.name ? `${state.org.name} · ` : ''}
              {state.user.email}
            </span>
          </span>
          <span className={styles.statusLine}>
            <StatusDot state={state} /> {statusLabel(state)}
          </span>
        </div>
      ) : (
        <>
          <div className={styles.stepField}>
            <label className={styles.stepLabel}>URL da plataforma</label>
            <UrlField state={state} onError={setError} />
            {state.config.locked.url && <span className={styles.locked}>🔒 Definido pela política da empresa</span>}
          </div>
          <div className={styles.stepActions}>
            <ConnectButtons state={state} onError={setError} />
            {state.status === 'connecting' && (
              <span className="muted" style={{ fontSize: 13 }}>
                Termine o login no navegador…
              </span>
            )}
          </div>
        </>
      )}
      {shownError && <div className={styles.errorRow}>{shownError}</div>}
    </>
  )
}
