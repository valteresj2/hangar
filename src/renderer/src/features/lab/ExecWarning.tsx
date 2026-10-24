// Explicit confirmation before a harness that changes what runs (hooks, helper commands, scripts) is applied
// to the project or used in a manual round. Main refuses without the confirmed fingerprint.
import { useState } from 'react'
import type { ExecChange } from '@shared/features/lab'
import styles from './lab.module.css'

const KIND_LABEL: Record<ExecChange['kind'], string> = {
  hook: 'Hook',
  command: 'Comando',
  script: 'Script',
  'inline-command': 'Comando embutido',
  permission: 'Permissão',
  env: 'Variável de ambiente'
}

const CHANGE_LABEL: Record<ExecChange['change'], string> = { added: 'novo', modified: 'alterado', removed: 'removido' }

export function ExecChangeList({ changes }: { changes: ExecChange[] }) {
  return (
    <ul className={styles.execList}>
      {changes.map((c, i) => (
        <li key={i} className={c.change === 'removed' ? styles.execRemoved : undefined}>
          <span className={styles.execKind}>
            {KIND_LABEL[c.kind]} · {CHANGE_LABEL[c.change]}
          </span>
          <code className={styles.execDetail}>{c.detail}</code>
          {c.detail !== c.path && <span className="muted"> em {c.path}</span>}
        </li>
      ))}
    </ul>
  )
}

export function ExecWarning({
  title,
  sections,
  confirmLabel,
  busy,
  onConfirm,
  onCancel
}: {
  title: string
  sections: { label?: string; changes: ExecChange[] }[]
  confirmLabel: string
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}) {
  const [checked, setChecked] = useState(false)
  return (
    <div className={styles.execWarning}>
      <strong>⚠ {title}</strong>
      <p>
        Estas mudanças fazem o Claude Code <b>executar comandos na sua máquina</b> (hooks, scripts, comandos de ajuda) ou ampliam o
        que ele pode fazer sem perguntar. Revise cada item: um harness gerado ou editado por outra pessoa pode conter comandos
        maliciosos.
      </p>
      {sections.map((s, i) => (
        <div key={i}>
          {s.label && <div className={styles.execSection}>{s.label}</div>}
          <ExecChangeList changes={s.changes} />
        </div>
      ))}
      <label className={styles.execConfirm}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        Revisei a lista e confio nesses comandos e arquivos.
      </label>
      <div className={styles.actions}>
        <button className="btn btn-primary" disabled={!checked || busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
