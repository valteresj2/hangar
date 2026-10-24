// Snapshots of the project's harness: create, compare with the current files, restore, delete.
import { useState } from 'react'
import type { HarnessSnapshot, HarnessTree, SnapshotSource } from '@shared/harness'
import { errorText, formatDate, harnessApi, useSnapshots } from './api'
import { DiffView } from './DiffView'
import { Confirm, ErrorLine } from './ui'
import styles from './harness.module.css'

const SOURCE_LABEL: Record<SnapshotSource, string> = {
  manual: 'manual',
  lab: 'lab',
  reflect: 'reflexão',
  restore: 'automático'
}

function defaultLabel(): string {
  return `Snapshot ${new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
}

export function SnapshotsTab({ project, dir, current }: { project: string; dir: string; current?: HarnessTree }) {
  const { data: snapshots, error: loadError } = useSnapshots(project)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [comparing, setComparing] = useState<string>()
  const [confirm, setConfirm] = useState<{ kind: 'restore' | 'delete'; snap: HarnessSnapshot }>()
  const [notice, setNotice] = useState<string>()

  const create = async () => {
    setBusy(true)
    try {
      await harnessApi.snapshotCreate(project, label.trim() || defaultLabel(), dir)
      setLabel('')
      setError(undefined)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.tabBody}>
      <div className={styles.createRow}>
        <input
          className="input"
          placeholder={defaultLabel()}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
          Criar snapshot
        </button>
      </div>
      <ErrorLine text={error ?? loadError} onClose={() => setError(undefined)} />
      {notice && (
        <div className={styles.notice} onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}

      <div className={styles.scroll}>
        {snapshots && snapshots.length === 0 && (
          <div className={styles.empty}>Nenhum snapshot ainda. Crie um antes de mexer no harness para poder comparar e voltar.</div>
        )}
        {snapshots?.map((s) => {
          const files = Object.keys(s.tree).length
          const open = comparing === s.id
          return (
            <div key={s.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div className={styles.cardMain}>
                  <div className={styles.cardTitle}>{s.label}</div>
                  <div className={styles.meta}>
                    <span className={styles.badge}>{SOURCE_LABEL[s.source]}</span>
                    <span>{formatDate(s.createdAt)}</span>
                    <span>
                      {files} arquivo{files === 1 ? '' : 's'}
                    </span>
                    {s.note && <span title={s.note}>· {s.note}</span>}
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <button className="btn" disabled={!current} onClick={() => setComparing(open ? undefined : s.id)}>
                    {open ? 'Fechar diff' : 'Comparar'}
                  </button>
                  <button className="btn" onClick={() => setConfirm({ kind: 'restore', snap: s })}>
                    Restaurar
                  </button>
                  <button className="icon-btn" title="Excluir snapshot" onClick={() => setConfirm({ kind: 'delete', snap: s })}>
                    ✕
                  </button>
                </div>
              </div>
              {open && current && <DiffView from={s.tree} to={current} fromLabel={s.label} toLabel="atual" />}
            </div>
          )
        })}
      </div>

      {confirm?.kind === 'restore' && (
        <Confirm
          title="Restaurar snapshot"
          message={
            <>
              Os arquivos de harness desta pasta voltam a ser os de <b>{confirm.snap.label}</b>: arquivos de harness que não existem
              no snapshot são apagados. Antes disso, o estado atual vira um snapshot automático. Arquivos fora do harness não são
              tocados.
            </>
          }
          confirm="Restaurar"
          onConfirm={async () => {
            try {
              await harnessApi.snapshotRestore(project, confirm.snap.id, dir)
              setNotice(`Restaurado “${confirm.snap.label}”. O estado anterior foi salvo como snapshot automático.`)
            } catch (err) {
              setError(errorText(err))
            }
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
      {confirm?.kind === 'delete' && (
        <Confirm
          title="Excluir snapshot"
          message={
            <>
              Excluir o snapshot <b>{confirm.snap.label}</b>? Os arquivos atuais não mudam.
            </>
          }
          confirm="Excluir"
          danger
          onConfirm={() => harnessApi.snapshotDelete(project, confirm.snap.id).catch((err) => setError(errorText(err)))}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </div>
  )
}
