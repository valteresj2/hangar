import type { TranscriptEntry } from '@shared/features/engine'
import { useUi } from '../../core/ui'
import styles from './engine.module.css'

type ProviderErrorEntry = Extract<TranscriptEntry, { kind: 'provider_error' }>

/** A turn failed (or is failing) because of the provider profile: credentials, endpoint or connection. */
export function ProviderErrorCard({ entry }: { entry: ProviderErrorEntry }) {
  return (
    <div className={`${styles.providerError} ${entry.retrying ? styles.providerWarning : ''}`}>
      <div className={styles.providerErrorIcon}>{entry.retrying ? '⚠' : '⛔'}</div>
      <div className={styles.providerErrorBody}>
        <div className={styles.providerErrorTitle}>
          {entry.retrying ? 'Problema com o provedor' : 'Falha no provedor'}: {entry.providerName}
        </div>
        <div className={styles.providerErrorMessage}>{entry.message}</div>
        <div className="muted">Confira a URL, a chave e os modelos do perfil, ou troque o provedor da sessão na barra abaixo.</div>
      </div>
      <button className="btn" onClick={() => useUi.getState().openSettings('providers')}>
        Abrir Provedores
      </button>
    </div>
  )
}
