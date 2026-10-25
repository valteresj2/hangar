import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PermissionRequest, PermissionResponse, RewindResult, TranscriptEntry } from '@shared/features/engine'
import { Markdown } from './Markdown'
import { MotionCard } from './MotionCard'
import { PermissionCard, PermissionSummary, QuestionCard } from './PermissionCard'
import { ProviderErrorCard } from './ProviderErrorCard'
import { ToolCard } from './ToolCard'
import { TASK_TOOLS } from './tools'
import { UserMessage } from './UserMessage'
import styles from './engine.module.css'

type Of<K extends TranscriptEntry['kind']> = Extract<TranscriptEntry, { kind: K }>

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.thinking}>
      <button className={styles.thinkingHeader} onClick={() => setOpen((o) => !o)}>
        {live ? 'Pensando…' : 'Pensamento'} <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className={styles.thinkingBody}>{text}</div>}
    </div>
  )
}

interface Props {
  entries: TranscriptEntry[]
  streamText: string
  streamThinking: string
  pending: PermissionRequest[]
  busy: boolean
  sessionId: string
  onRespond(requestId: string, response: PermissionResponse): void
  onRewound(result: RewindResult): void
  onError(message: string): void
  /** Sends a Motion fix request (from an invalid animation card). */
  onAskFix(text: string): void
}

export function Transcript(props: Props) {
  const { entries, streamText, streamThinking, pending, busy, sessionId, onRespond, onRewound, onError, onAskFix } =
    props
  const [lightbox, setLightbox] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  const { results, decisions } = useMemo(() => {
    const results = new Map<string, Of<'tool_result'>>()
    const decisions = new Map<string, Of<'permission_decision'>>()
    for (const e of entries) {
      if (e.kind === 'tool_result') results.set(e.toolUseId, e)
      else if (e.kind === 'permission_decision') decisions.set(e.requestId, e)
    }
    return { results, decisions }
  }, [entries])
  const pendingIds = useMemo(() => new Set(pending.map((p) => p.requestId)), [pending])

  // Smart autoscroll: follow new content only while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  // Sending a message always brings the view back to the end.
  const last = entries[entries.length - 1]
  useLayoutEffect(() => {
    if (last?.kind !== 'user' || !scroller.current) return
    stick.current = true
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [last])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    // Content can grow between our programmatic scroll and its (async) scroll event, so only an
    // upward move counts as the user leaving the bottom.
    if (bottom) stick.current = true
    else if (el.scrollTop < lastTop.current - 1) stick.current = false
    lastTop.current = el.scrollTop
    setAtBottom(bottom || stick.current)
  }

  const scrollToBottom = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // Requests whose entry is missing (should not happen) still get a card at the end.
  const shownInline = new Set<string>()

  return (
    <div className={styles.transcriptWrap}>
      <div className={styles.scroller} ref={scroller} onScroll={onScroll}>
        <div className={styles.transcript} ref={content}>
          {entries.map((e) => {
            switch (e.kind) {
              case 'user':
                return (
                  <UserMessage
                    key={e.id}
                    entry={e}
                    sessionId={sessionId}
                    busy={busy}
                    onRewound={onRewound}
                    onError={onError}
                    onOpenImage={setLightbox}
                  />
                )
              case 'assistant':
                return <Markdown key={e.id} text={e.text} />
              case 'thinking':
                return <Thinking key={e.id} text={e.text} />
              case 'tool_use':
                if (TASK_TOOLS.has(e.name) || e.name === 'AskUserQuestion') return null
                return <ToolCard key={e.id} use={e} result={results.get(e.toolUseId)} running={busy} />
              case 'permission_request': {
                const req = e.request
                if (pendingIds.has(req.requestId)) {
                  shownInline.add(req.requestId)
                  return req.questions ? (
                    <QuestionCard key={e.id} request={req} onRespond={onRespond} />
                  ) : (
                    <PermissionCard key={e.id} request={req} onRespond={onRespond} />
                  )
                }
                return <PermissionSummary key={e.id} request={req} decision={decisions.get(req.requestId)} />
              }
              case 'result':
                return e.errors?.length ? (
                  <div key={e.id} className={styles.error}>
                    {e.errors.join('\n')}
                  </div>
                ) : null
              case 'motion':
                return <MotionCard key={e.id} entry={e} busy={busy} onAskFix={onAskFix} />
              case 'provider_error':
                return <ProviderErrorCard key={e.id} entry={e} sessionId={sessionId} />
              case 'system':
                return (
                  <div key={e.id} className={styles.system}>
                    {e.text}
                  </div>
                )
              case 'error':
                return (
                  <div key={e.id} className={styles.error}>
                    {e.message}
                  </div>
                )
              default:
                return null
            }
          })}
          {pending
            .filter((p) => !shownInline.has(p.requestId))
            .map((p) =>
              p.questions ? (
                <QuestionCard key={p.requestId} request={p} onRespond={onRespond} />
              ) : (
                <PermissionCard key={p.requestId} request={p} onRespond={onRespond} />
              )
            )}
          {streamThinking && <Thinking text={streamThinking} live />}
          {streamText && <Markdown text={streamText} />}
          {busy && pending.length === 0 && (
            <div className={styles.working}>
              <span className={styles.spinner} /> Trabalhando…
            </div>
          )}
        </div>
      </div>
      {lightbox && (
        <div className={styles.lightbox} onClick={() => setLightbox(undefined)} title="Fechar">
          <img src={lightbox} alt="Imagem" />
        </div>
      )}
      {!atBottom && (
        <button className={styles.toBottom} onClick={scrollToBottom} title="Ir para o fim">
          ↓
        </button>
      )}
    </div>
  )
}
