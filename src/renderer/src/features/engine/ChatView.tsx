import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@shared/contracts'
import { ENGINE, type OutputMode, type PermissionResponse, type RewindResult, type SendOptions, type TodoItem, type TranscriptEntry } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { useUi } from '../../core/ui'
import { Composer, type ComposerDraft } from './Composer'
import { useOutputMode } from './MotionCard'
import { blobToImage, type ComposerImage } from './pasted'
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

const SUGGESTIONS: { icon: string; label: string; text: string; output?: OutputMode }[] = [
  { icon: '🎬', label: 'Criar uma animação (Motion)', text: 'Crie uma animação de 20 segundos explicando ', output: 'motion' },
  { icon: '🧭', label: 'Explicar este projeto', text: 'Explique a estrutura deste projeto e como rodá-lo.' },
  { icon: '🐞', label: 'Procurar bugs', text: 'Procure bugs prováveis no código desta pasta e liste os mais importantes, com arquivo e linha.' },
  { icon: '🧪', label: 'Escrever testes', text: 'Escreva testes para a parte mais importante e menos testada deste projeto.' }
]

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
}

/** Transcript + composer for one session. */
export function ChatView({ session }: { session: Session }) {
  const chat = useChat(session.id)
  const [attachments, setAttachments] = useState<string[]>([])
  const [images, setImages] = useState<ComposerImage[]>([])
  const [draft, setDraft] = useState<ComposerDraft>()
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [output, setOutput] = useOutputMode(session.id)
  const busy = chat.busy || session.status === 'working' || session.status === 'waiting'

  useEffect(() => {
    void bridge.invoke(ENGINE.setActive, session.id)
    return () => void bridge.invoke(ENGINE.setActive, undefined)
  }, [session.id])

  // After a fork, main asks us to open the new session.
  useEffect(
    () => bridge.on(ENGINE.evSelect, ({ sessionId }: { sessionId: string }) => useUi.getState().selectSession(sessionId)),
    []
  )

  const onSend = useCallback(
    async (text: string) => {
      setError(undefined)
      setNotice(undefined)
      const opts: SendOptions = {
        ...(attachments.length ? { attachments } : {}),
        ...(images.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}),
        ...(output ? { output } : {})
      }
      try {
        await bridge.invoke(ENGINE.send, session.id, text, opts)
        setAttachments([])
        setImages([])
        return true
      } catch (err) {
        setError(errorText(err))
        return false
      }
    },
    [attachments, images, output, session.id]
  )

  const onAskFix = useCallback(
    (text: string) => {
      setError(undefined)
      bridge.invoke(ENGINE.send, session.id, text, { output: 'motion' } satisfies SendOptions).catch((err) => setError(errorText(err)))
    },
    [session.id]
  )

  const suggest = (text: string, mode?: OutputMode) => {
    setOutput(mode)
    setDraft({ text, nonce: Date.now() })
  }

  const onRewound = useCallback((result: RewindResult) => {
    setDraft({ text: result.text, nonce: Date.now() })
    setOutput(result.output)
    setAttachments(result.attachments ?? [])
    setImages(
      (result.images ?? []).map((img) => ({ ...img, id: crypto.randomUUID(), url: `data:${img.mediaType};base64,${img.data}` }))
    )
    if (result.filesError) setError(`A conversa voltou, mas os arquivos não foram restaurados: ${result.filesError}`)
    else if (result.filesRestored?.length) setNotice(`Arquivos restaurados: ${result.filesRestored.map((f) => f.split(/[\\/]/).pop()).join(', ')}`)
  }, [setOutput])

  const onDropFiles = (list: FileList) => {
    const withPath: string[] = []
    for (const f of list) {
      const path = bridge.pathForFile(f)
      if (path) withPath.push(path)
      else if (f.type.startsWith('image/')) {
        blobToImage(f).then(
          (img) => setImages((all) => [...all, img]),
          (err) => setError(errorText(err))
        )
      }
    }
    setAttachments((a) => [...a, ...withPath.filter((p) => !a.includes(p))])
  }

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
        onDropFiles(e.dataTransfer.files)
      }}
    >
      {chat.loaded && chat.entries.length === 0 && !busy ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{session.title}</div>
          <div className="muted">{session.worktree?.path ?? session.cwd}</div>
          <div className={styles.suggestions}>
            {SUGGESTIONS.map((s) => (
              <button key={s.label} className={styles.suggestion} onClick={() => suggest(s.text, s.output)}>
                <span className={styles.suggestionIcon}>{s.icon}</span>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Transcript
          entries={chat.entries}
          streamText={chat.streamText}
          streamThinking={chat.streamThinking}
          pending={chat.pending}
          busy={busy}
          sessionId={session.id}
          onRespond={onRespond}
          onRewound={onRewound}
          onError={setError}
          onAskFix={onAskFix}
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
        {notice && (
          <div className={styles.notice}>
            {notice}
            <button className="icon-btn" onClick={() => setNotice(undefined)}>
              ×
            </button>
          </div>
        )}
        <Composer
          session={session}
          busy={busy}
          attachments={attachments}
          setAttachments={setAttachments}
          images={images}
          setImages={setImages}
          draft={draft}
          output={output}
          setOutput={setOutput}
          onSend={onSend}
          onStop={onStop}
          onError={setError}
        />
        <Footer entries={chat.entries} />
      </div>
      {dragging && <div className={styles.dropHint}>Solte para anexar</div>}
    </div>
  )
}
