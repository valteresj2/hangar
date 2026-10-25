import type { TranscriptEntry } from '@shared/features/engine'
import { useUi } from '../../core/ui'
import { GatewayFixButton } from '../onboarding'
import styles from './engine.module.css'

type ProviderErrorEntry = Extract<TranscriptEntry, { kind: 'provider_error' }>

/** A turn failed (or is failing) because of the provider profile: credentials, endpoint or connection. */
export function ProviderErrorCard({ entry, sessionId }: { entry: ProviderErrorEntry; sessionId: string }) {
  return (
    <div className={`${styles.providerError} ${entry.retrying ? styles.providerWarning : ''}`}>
      <div className={styles.providerErrorIcon}>{entry.retrying ? '⚠' : '⛔'}</div>
      <div className={styles.providerErrorBody}>
        <div className={styles.providerErrorTitle}>
          {entry.retrying ? 'Problema com o provedor' : 'Falha no provedor'}: {entry.providerName}
        </div>
        <div className={styles.providerErrorMessage}>{entry.message}</div>
        <div className="muted">
          Confira a URL, a chave e os modelos do perfil, ou troque o provedor da sessão na barra abaixo.
        </div>
      </div>
      <div className={styles.providerErrorActions}>
        {/* Offers the one-click "subscription, direct" fix when the gateway in ~/.claude/settings.json is the cause. */}
        <GatewayFixButton sessionId={sessionId} />
        <button className="btn" onClick={() => useUi.getState().openSettings('providers')}>
          Abrir Provedores
        </button>
      </div>
    </div>
  )
}
