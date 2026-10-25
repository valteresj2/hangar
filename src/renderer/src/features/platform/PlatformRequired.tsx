// Banner shown where sessions are created while the platform is required and not connected.
import { useState } from 'react'
import { PLATFORM_REQUIRED_MESSAGE } from '@shared/features/platform'
import { useUi } from '../../core/ui'
import { platformApi, runAction, usePlatform } from './api'
import styles from './platform.module.css'

export function PlatformRequiredNotice() {
  const state = usePlatform()
  const [error, setError] = useState<string>()
  if (!state || state.canCreateSessions) return null
  const connecting = state.status === 'connecting'
  return (
    <div className={styles.required} role="alert">
      <div style={{ flex: 1 }}>
        <strong>Conectar à plataforma</strong>
        <div>{PLATFORM_REQUIRED_MESSAGE}</div>
        {(error ?? state.error) && <div className={styles.textBad}>{error ?? state.error}</div>}
      </div>
      {state.config.url ? (
        <button
          className="btn btn-primary"
          disabled={connecting}
          onClick={() => void runAction(() => platformApi.connect()).then(setError)}
        >
          {connecting ? 'Aguardando o navegador…' : 'Conectar à plataforma'}
        </button>
      ) : (
        <button className="btn btn-primary" onClick={() => useUi.getState().openSettings('platform')}>
          Configurar
        </button>
      )}
    </div>
  )
}
