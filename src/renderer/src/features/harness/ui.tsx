// Small shared UI pieces: confirmation dialog and inline error.
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './harness.module.css'

export function Confirm(props: {
  title: string
  message: ReactNode
  confirm: string
  danger?: boolean
  onConfirm: () => Promise<unknown> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props])

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={props.title}>
        <div className={styles.modalTitle}>{props.title}</div>
        <div className={styles.modalBody}>{props.message}</div>
        <div className={styles.modalActions}>
          <button className="btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button
            className={`btn ${props.danger ? styles.btnDanger : 'btn-primary'}`}
            autoFocus
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                try {
                  await props.onConfirm()
                } finally {
                  setBusy(false)
                  props.onClose()
                }
              })()
            }
          >
            {busy ? 'Aguarde…' : props.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function ErrorLine({ text, onClose }: { text?: string; onClose?: () => void }) {
  if (!text) return null
  return (
    <div className={styles.error} onClick={onClose} title={onClose ? 'Fechar' : undefined}>
      {text}
    </div>
  )
}
