// Small presentational building blocks shared by the settings sections.
import type { ReactNode } from 'react'
import styles from './settings.module.css'

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.card}>
      {title && (
        <div className={styles.cardTitle}>
          <span style={{ flex: 1 }}>{title}</span>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <div>{label}</div>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
      {children && <div className={styles.control}>{children}</div>}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className={styles.segmented} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? styles.segActive : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Dot({ tone }: { tone: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  const cls = tone === 'ok' ? styles.ok : tone === 'bad' ? styles.bad : tone === 'warn' ? styles.warn : ''
  return <span className={`${styles.dot} ${cls}`} />
}

export function Spinner() {
  return <span className={styles.spinner} aria-label="Carregando" />
}

export function Kbd({ keys }: { keys: string }) {
  return (
    <span>
      {keys.split('+').map((k, i) => (
        <kbd key={i} className={styles.kbd}>
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function formatDateTime(ts: number | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
