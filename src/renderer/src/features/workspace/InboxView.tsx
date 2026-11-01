// Caixa de entrada: decisions, tasks the person asked for, what got stuck on the employees they manage… (GET
// /api/inbox?view=…), with read/unread and archive (POST /api/inbox/mark). Decisions open the app's Decisões;
// the rest opens its page on the portal.
import { useEffect, useState } from 'react'
import type { InboxItem, InboxView as Tab, WorkspaceState } from '@shared/features/workspace'
import { useUi } from '../../core/ui'
import { openPortal, workspaceApi } from './api'
import { ago, TASK_STATUS, statusOf } from './format'
import { LiveNote } from './WorkspaceView'
import styles from './workspace.module.css'

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'unread', label: 'Não lidas' },
  { id: 'decisions', label: 'Decisões' },
  { id: 'blocked', label: 'Travadas' },
  { id: 'mine', label: 'Que eu pedi' },
  { id: 'archived', label: 'Arquivadas' }
]

const KIND: Record<string, string> = {
  decision: 'decisão',
  task: 'tarefa',
  stuck: 'travada',
  connector: 'conector',
  model_suggestion: 'sugestão de modelo',
  execution_suggestion: 'sugestão de esforço'
}

const message = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

function open(item: InboxItem): void {
  if (item.decisionId) useUi.getState().openWorkspace('decisions')
  else if (item.taskId) openPortal({ screen: 'task', id: item.taskId }, item.title)
  else if (item.employee) openPortal({ screen: 'employee', slug: item.employee }, item.employeeName)
  else openPortal({ screen: 'inbox' })
}

export function InboxView({ state }: { state: WorkspaceState }) {
  const [tab, setTab] = useState<Tab>('all')
  const [items, setItems] = useState<InboxItem[]>()
  const [error, setError] = useState<string>()
  // The inbox moves with the platform's events: fetch again whenever its counts were refreshed.
  const stamp = state.inbox.fetchedAt

  useEffect(() => {
    let alive = true
    workspaceApi
      .inbox(tab)
      .then((list) => {
        if (!alive) return
        setItems(list)
        setError(undefined)
      })
      .catch((err) => alive && setError(message(err)))
    return () => {
      alive = false
    }
  }, [tab, stamp])

  const mark = async (item: InboxItem, change: { read?: boolean; archived?: boolean }) => {
    // Shown at once; the refresh confirms it (or brings it back with the error).
    setItems((list) =>
      list
        ?.map((x) =>
          x.key === item.key
            ? {
                ...x,
                unread: change.read === undefined ? x.unread : !change.read,
                archived: change.archived ?? x.archived
              }
            : x
        )
        .filter((x) => (tab === 'archived' ? x.archived : !x.archived) && (tab !== 'unread' || x.unread))
    )
    try {
      await workspaceApi.markInbox([item.key], change)
    } catch (err) {
      setError(message(err))
    }
  }

  const unread = (items ?? []).filter((x) => x.unread)
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.h1}>Caixa de entrada</h1>
          <div className={styles.sub}>
            Decisões, tarefas que você pediu e o que travou nos seus agentes · <LiveNote state={state} />
          </div>
        </div>
        <div className={styles.headActions}>
          {unread.length > 0 && tab !== 'archived' && (
            <button
              className="btn"
              onClick={() => {
                const keys = unread.map((x) => x.key)
                setItems((list) =>
                  list?.map((x) => ({ ...x, unread: false })).filter((x) => tab !== 'unread' || x.unread)
                )
                void workspaceApi.markInbox(keys, { read: true }).catch((err) => setError(message(err)))
              }}
            >
              Marcar todas como lidas
            </button>
          )}
          <button className="btn" onClick={() => openPortal({ screen: 'inbox' })}>
            Abrir no portal ↗
          </button>
        </div>
      </div>
      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'unread' && state.inbox.data?.unread ? ` (${state.inbox.data.unread})` : ''}
          </button>
        ))}
      </div>
      {error && (
        <div className={styles.staleBanner} role="alert">
          <span>{error}</span>
        </div>
      )}
      {!items && !error && (
        <div className={styles.loading} aria-busy="true">
          <span className={styles.spinner} /> Carregando a caixa de entrada…
        </div>
      )}
      {items && items.length === 0 && <div className={`${styles.card} muted`}>Nada aqui.</div>}
      {items?.map((x) => {
        const st = x.status ? statusOf(TASK_STATUS, x.status) : undefined
        return (
          <div
            key={x.key}
            className={`${styles.card} ${styles.inboxRow} ${x.unread ? styles.inboxUnread : ''}`}
            data-inbox={x.key}
          >
            <button className={styles.inboxMain} onClick={() => open(x)}>
              {x.unread && <span className={styles.unreadDot} aria-label="não lida" />}
              <span className={styles.inboxTitle}>{x.title}</span>
              <span className={`muted ${styles.small}`}>
                {[KIND[x.kind] ?? x.kind, x.employeeName, ago(x.at)].filter(Boolean).join(' · ')}
              </span>
            </button>
            <div className={styles.agentActions}>
              {st && <span className={st.className}>{st.label}</span>}
              {x.blocked && <span className="pill pill-stop">travada</span>}
              <button className="btn" onClick={() => void mark(x, { read: x.unread })}>
                {x.unread ? 'Marcar como lida' : 'Marcar como não lida'}
              </button>
              <button className="btn" onClick={() => void mark(x, { archived: !x.archived })}>
                {x.archived ? 'Desarquivar' : 'Arquivar'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
