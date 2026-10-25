// Small building blocks of the workspace screens.
import { initials } from './format'
import styles from './workspace.module.css'

export function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.kpi} data-kpi={label}>
      <div className={styles.kpiValue}>{value}</div>
      <div className={styles.kpiLabel}>{label}</div>
    </div>
  )
}

export function CardHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className={styles.cardHead}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {action && onAction && (
        <button className={styles.cardAction} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  )
}

/** The agent's initials (the platform's avatar images are not loaded into the app). */
export function AgentAvatar({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
