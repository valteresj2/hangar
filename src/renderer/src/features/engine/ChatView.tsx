import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@shared/contracts'
import { ENGINE, type PermissionResponse, type SendOptions, type TodoItem, type TranscriptEntry } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import { latestTodos } from './tools'
import { useChat } from './useChat'
import styles from './engine.module.css'

function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true)
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className={styles.todos}>
      <button className={styles.todosHeader} onClick={() => setOpen((o) => !o)}>
        Tarefas {done}/{todos.length} <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className={styles.todoList}>
          {todos.map((t, i) => (
            <li key={i} className={styles[`todo_${t.status}`]}>
              <span className={styles.todoBox}>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''}</span>
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
}

function Footer({ entries }: { entries: TranscriptEntry[] }) {
  const last = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'result') return e
    }
    return undefined
  }, [entries])
  if (!last) return null
  const pct = last.contextTokens && last.contextWindow ? Math.round((last.contextTokens / last.contextWindow) * 100) : undefined
  return (
    <div className={styles.footer}>
      <span title="Duração da última rodada">{(last.durationMs / 1000).toFixed(1)} s</span>
      <span title="Custo estimado acumulado desta execução">US$ {last.costUsd.toFixed(4)}</span>
      <span title="Tokens da última rodada (entrada + cache / saída)">
        {formatTokens(last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens)} ↑ · {formatTokens(last.outputTokens)} ↓
      </span>
      {pct !== undefined && (
        <span className={styles.context} title={`Contexto: ${last.contextTokens?.toLocaleString('pt-BR')} de ${last.contextWindow?.toLocaleString('pt-BR')} tokens`}>
          <span className={styles.contextBar}>
            <span style={{ width: `${Math.min(pct, 100)}%` }} />
          </span>
          {pct}% do contexto
        </span>
      )}
    </div>
  )
}

/** Transcript + composer for one session. */
export function ChatView({ session }: { session: Session }) {
  const chat = useChat(session.id)
  const [attachments, setAttachments] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string>()
  const busy = chat.busy || session.status === 'working' || session.status === 'waiting'

  useEffect(() => {
    void bridge.invoke(ENGINE.setActive, session.id)
    return () => void bridge.invoke(ENGINE.setActive, undefined)
  }, [session.id])

  const onSend = useCallback(
    async (text: string) => {
      setError(undefined)
      const opts: SendOptions = attachments.length ? { attachments } : {}
      try {
        await bridge.invoke(ENGINE.send, session.id, text, opts)
        setAttachments([])
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
        return false
      }
    },
    [attachments, session.id]
  )

  const onStop = useCallback(() => void bridge.invoke(ENGINE.interrupt, session.id), [session.id])
  const onRespond = useCallback(
    (requestId: string, response: PermissionResponse) => void bridge.invoke(ENGINE.respondPermission, session.id, requestId, response),
    [session.id]
  )

  const todos = useMemo(() => latestTodos(chat.entries), [chat.entries])
  const showTodos = todos && todos.length > 0 && (busy || todos.some((t) => t.status !== 'completed'))

  return (
    <div
      className={`${styles.chat} ${dragging ? styles.dragging : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean)
        setAttachments((a) => [...a, ...paths.filter((p) => !a.includes(p))])
      }}
    >
      {chat.loaded && chat.entries.length === 0 && !busy ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{session.title}</div>
          <div className="muted">{session.worktree?.path ?? session.cwd}</div>
        </div>
      ) : (
        <Transcript
          entries={chat.entries}
          streamText={chat.streamText}
          streamThinking={chat.streamThinking}
          pending={chat.pending}
          busy={busy}
          onRespond={onRespond}
        />
      )}
      <div className={styles.bottom}>
        {showTodos && <TodoPanel todos={todos} />}
        {error && (
          <div className={styles.error}>
            {error}
            <button className="icon-btn" onClick={() => setError(undefined)}>
              ×
            </button>
          </div>
        )}
        <Composer
          session={session}
          busy={busy}
          attachments={attachments}
          setAttachments={setAttachments}
          onSend={onSend}
          onStop={onStop}
        />
        <Footer entries={chat.entries} />
      </div>
      {dragging && <div className={styles.dropHint}>Solte para anexar</div>}
    </div>
  )
}
