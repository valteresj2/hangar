// Side-panel tab: the project's harness — components (on disk), snapshots and lessons.
import { useState } from 'react'
import type { Session } from '@shared/contracts'
import type { HarnessTree } from '@shared/harness'
import { templateFiles, type TemplateKind } from '@shared/features/harness'
import { useUi } from '../../core/ui'
import { harnessApi, shortPath, useHarnessState, useLessons, useSnapshots } from './api'
import { ComponentsEditor } from './ComponentsEditor'
import { LessonsTab } from './LessonsTab'
import { SnapshotsTab } from './SnapshotsTab'
import { ErrorLine } from './ui'
import styles from './harness.module.css'

type Tab = 'components' | 'snapshots' | 'lessons'

export function HarnessPanel({ session }: { session: Session }) {
  const project = session.worktree?.baseCwd ?? session.cwd
  const dir = session.worktree?.path ?? session.cwd
  const [tab, setTab] = useState<Tab>('components')
  const { data: state, error } = useHarnessState(dir)
  const { data: snapshots } = useSnapshots(project)
  const { data: lessons } = useLessons(project)

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'components', label: 'Componentes', count: state ? Object.keys(state.tree).length : undefined },
    { id: 'snapshots', label: 'Snapshots', count: snapshots?.length },
    { id: 'lessons', label: 'Lições', count: lessons?.filter((l) => l.enabled).length }
  ]

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <div className={styles.projectName} title={project}>
            Harness · {shortPath(project)}
          </div>
          {session.worktree && (
            <div className={styles.meta} title={dir}>
              Componentes do worktree <code>{session.worktree.branch}</code>; snapshots e lições são do projeto.
            </div>
          )}
        </div>
        <button className="btn" onClick={() => useUi.getState().openLab(project)} title="Comparar variantes do harness com seleção cega">
          Abrir Lab
        </button>
      </header>

      <nav className={styles.tabs}>
        {tabs.map((t) => (
          <button key={t.id} className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count !== undefined && <span className={styles.count}>{t.count}</span>}
          </button>
        ))}
      </nav>

      {tab === 'components' &&
        (state ? (
          <ComponentsEditor
            tree={state.tree}
            skipped={state.skipped}
            mode="save"
            onSave={(rel, content) => harnessApi.writeFile(dir, rel, content)}
            onDelete={(rel) => harnessApi.deleteFile(dir, rel)}
            onCreate={(kind, name) => harnessApi.createFromTemplate(dir, kind, name)}
          />
        ) : (
          <div className={styles.tabBody}>
            <ErrorLine text={error} />
            {!error && <div className={styles.empty}>Lendo o harness…</div>}
          </div>
        ))}
      {tab === 'snapshots' && <SnapshotsTab project={project} dir={dir} current={state?.tree} />}
      {tab === 'lessons' && <LessonsTab session={session} project={project} />}
    </div>
  )
}

/** In-memory version of the components editor: every edit calls onChange with the new tree. */
export function HarnessTreeEditor({ tree, onChange, readOnly }: { tree: HarnessTree; onChange: (tree: HarnessTree) => void; readOnly?: boolean }) {
  return (
    <ComponentsEditor
      tree={tree}
      mode="live"
      readOnly={readOnly}
      onSave={(rel, content) => onChange({ ...tree, [rel]: content })}
      onDelete={(rel) => {
        const next = { ...tree }
        delete next[rel]
        onChange(next)
      }}
      onCreate={(kind: TemplateKind, name: string) => {
        const files = templateFiles(kind, name)
        const clash = Object.keys(files).find((p) => p in tree)
        if (clash) throw new Error(`Já existe: ${clash}`)
        onChange({ ...tree, ...files })
        return Object.keys(files)
      }}
    />
  )
}
