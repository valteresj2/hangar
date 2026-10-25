// Small building blocks shared by the sidebar and the session header.
import { useRef, useState } from 'react'
import type { Session } from '@shared/contracts'
import styles from './sessions.module.css'

export function RenameInput({
  initial,
  onDone,
  className
}: {
  initial: string
  onDone: (title?: string) => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (title?: string) => {
    if (done.current) return
    done.current = true
    onDone(title)
  }
  return (
    <input
      className={`input ${styles.renameInput} ${className ?? ''}`}
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') finish()
      }}
      onBlur={() => finish(value)}
    />
  )
}

export function StatusDot({ session }: { session: Session }) {
  if (session.status === 'working') return <span className={styles.spinner} title="Trabalhando" />
  if (session.status === 'waiting')
    return <span className={`${styles.dot} ${styles.dotWaiting}`} title="Aguardando você" />
  if (session.status === 'error') return <span className={`${styles.dot} ${styles.dotError}`} title="Erro" />
  if (session.unread) return <span className={`${styles.dot} ${styles.dotUnread}`} title="Não lida" />
  return <span className={styles.dotSpace} />
}
