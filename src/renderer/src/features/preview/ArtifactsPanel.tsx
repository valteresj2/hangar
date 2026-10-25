// Artifacts of a session (HTML / SVG / Markdown / Mermaid / Motion) and an isolated viewer.
// HTML and Mermaid render in <iframe sandbox="allow-scripts"> (opaque origin, no access to the app),
// SVG as an <img>, Markdown with react-markdown, Motion in the player/editor (motion/MotionViewer).
import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Session } from '@shared/contracts'
import {
  PREVIEW,
  type Artifact,
  type ArtifactContent,
  type ArtifactKind,
  type ArtifactsEvent
} from '@shared/features/preview'
import { api, bridge } from '../../core/api'
import { MotionViewer } from './motion/MotionViewer'
import { NewMotionForm } from './motion/NewMotionForm'
import { onOpenRequest, takeOpenRequest } from './motion/openRequests'
import styles from './preview.module.css'

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: 'HTML',
  svg: 'SVG',
  markdown: 'MD',
  mermaid: 'MMD',
  motion: 'MOT'
}

/** Selected artifact per session, remembered while the app is open. */
const selectedBySession = new Map<string, string>()

function errorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const relativeTime = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
function ago(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000)
  if (s > -60) return 'agora'
  if (s > -3600) return relativeTime.format(Math.round(s / 60), 'minute')
  if (s > -86400) return relativeTime.format(Math.round(s / 3600), 'hour')
  return relativeTime.format(Math.round(s / 86400), 'day')
}

function useArtifacts(sessionId: string) {
  const [list, setList] = useState<Artifact[]>([])
  const [lastEvent, setLastEvent] = useState<ArtifactsEvent & { n: number }>()
  useEffect(() => {
    let alive = true
    let n = 0
    const load = () => void bridge.invoke<Artifact[]>(PREVIEW.artifacts, sessionId).then((r) => alive && setList(r))
    load()
    const off = bridge.on(PREVIEW.artifactsEvent, (e: ArtifactsEvent) => {
      if (e.sessionId !== sessionId) return
      load()
      setLastEvent({ ...e, n: ++n })
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return { list, lastEvent }
}

function SvgView({ content }: { content: string }) {
  const src = useMemo(() => URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' })), [content])
  useEffect(() => () => URL.revokeObjectURL(src), [src])
  return (
    <div className={styles.svgView}>
      <img src={src} alt="" />
    </div>
  )
}

function MarkdownView({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href && /^https?:/i.test(href)) void api.openExternal(href)
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}

function FramedView({ data, version }: { data: ArtifactContent; version: number }) {
  if (data.url) {
    const url = new URL(data.url)
    // Changing the URL (manual reload or new file contents) remounts the frame.
    url.searchParams.set('v', `${version}-${data.mtime}`)
    return (
      <iframe
        key={url.href}
        className={styles.frame}
        sandbox="allow-scripts"
        src={url.href}
        title={data.artifact.name}
      />
    )
  }
  // Fallback when the local artifact server is unavailable: inline scripts are blocked by the app CSP here.
  if (data.artifact.kind === 'mermaid') return <pre className={styles.source}>{data.content}</pre>
  return <iframe className={styles.frame} sandbox="allow-scripts" srcDoc={data.content} title={data.artifact.name} />
}

function ArtifactBar({
  artifact,
  onReload,
  onError
}: {
  artifact: Artifact
  onReload(): void
  onError(message: string): void
}) {
  const act = (channel: string) => bridge.invoke(channel, artifact.id).catch((err) => onError(errorMessage(err)))
  return (
    <div className={styles.viewerBar}>
      <div className={styles.viewerTitle}>
        <strong className={styles.ellipsis}>{artifact.name}</strong>
        <span className={`muted ${styles.ellipsis}`} title={artifact.path}>
          {artifact.path}
        </span>
      </div>
      <button className="icon-btn" title="Recarregar do disco" onClick={onReload}>
        ⟳
      </button>
      <button
        className="icon-btn"
        title="Abrir no navegador / app padrão"
        onClick={() => void act(PREVIEW.artifactOpen)}
      >
        ⧉
      </button>
      <button className="icon-btn" title="Abrir pasta" onClick={() => void act(PREVIEW.artifactReveal)}>
        📁
      </button>
      <button className="icon-btn" title="Remover da lista" onClick={() => void act(PREVIEW.artifactRemove)}>
        🗑
      </button>
    </div>
  )
}

function MotionArtifact({
  artifact,
  sessionId,
  version,
  onReload
}: {
  artifact: Artifact
  sessionId: string
  version: number
  onReload(): void
}) {
  const [error, setError] = useState<string>()
  return (
    <div className={styles.viewer}>
      <ArtifactBar artifact={artifact} onReload={onReload} onError={setError} />
      {error && <div className={styles.errorText}>{error}</div>}
      <MotionViewer key={version} artifact={artifact} sessionId={sessionId} />
    </div>
  )
}

function Viewer({ artifact, version, onReload }: { artifact: Artifact; version: number; onReload(): void }) {
  const [data, setData] = useState<ArtifactContent>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    setError(undefined)
    bridge.invoke<ArtifactContent>(PREVIEW.artifactRead, artifact.path).then(
      (d) => alive && setData(d),
      (err) => {
        if (!alive) return
        setData(undefined)
        setError(errorMessage(err))
      }
    )
    return () => {
      alive = false
    }
  }, [artifact.path, artifact.updatedAt, version])

  return (
    <div className={styles.viewer}>
      <ArtifactBar artifact={artifact} onReload={onReload} onError={setError} />
      {error ? (
        <div className={styles.errorBox}>{error}</div>
      ) : !data || data.artifact.id !== artifact.id ? (
        <div className={`muted ${styles.centered}`}>Carregando…</div>
      ) : (
        <>
          {data.truncated && <div className={styles.errorText}>Arquivo grande: mostrando só os primeiros 5 MB.</div>}
          {artifact.kind === 'svg' && <SvgView content={data.content} />}
          {artifact.kind === 'markdown' && <MarkdownView content={data.content} />}
          {(artifact.kind === 'html' || artifact.kind === 'mermaid') && <FramedView data={data} version={version} />}
        </>
      )}
    </div>
  )
}

function SessionArtifacts({ session }: { session: Session }) {
  const sessionId = session.id
  const { list, lastEvent } = useArtifacts(sessionId)
  const [selectedId, setSelectedId] = useState<string | undefined>(() => selectedBySession.get(sessionId))
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [newMotion, setNewMotion] = useState(false)
  const [notice, setNotice] = useState<string>()

  const select = useCallback(
    (id: string | undefined) => {
      setSelectedId(id)
      if (id) selectedBySession.set(sessionId, id)
      else selectedBySession.delete(sessionId)
    },
    [sessionId]
  )

  // A newly written artifact gets selected so it shows up on its own.
  useEffect(() => {
    if (lastEvent?.artifactId) select(lastEvent.artifactId)
  }, [lastEvent, select])

  const selected = list.find((a) => a.id === selectedId) ?? list[0]

  const add = useCallback(
    async (path?: string) => {
      setError(undefined)
      try {
        const artifact = await bridge.invoke<Artifact | undefined>(PREVIEW.artifactAdd, sessionId, path)
        if (artifact) select(artifact.id)
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [sessionId, select]
  )

  // "Abrir no player" from the chat (OPEN_ARTIFACT_EVENT): registering again is idempotent and selects it.
  useEffect(() => {
    const consume = () => {
      const path = takeOpenRequest()
      if (path) void add(path)
    }
    consume()
    return onOpenRequest(consume)
  }, [add])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  return (
    <div
      className={`${styles.panel} ${dragging ? styles.dropping : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        for (const file of Array.from(e.dataTransfer.files)) void add(bridge.pathForFile(file))
      }}
    >
      <div className={styles.artifactsHeader}>
        <strong>Artifacts</strong>
        <span className="muted">{list.length || ''}</span>
        <div className={styles.flex} />
        <button className="btn" onClick={() => setNewMotion(true)} title="Pedir ao Claude uma animação Hangar Motion">
          Novo Motion
        </button>
        <button className="btn" onClick={() => void add()}>
          Abrir arquivo como artifact…
        </button>
      </div>
      {error && <div className={styles.errorText}>{error}</div>}
      {notice && <div className={styles.noticeText}>{notice}</div>}
      {newMotion && (
        <NewMotionForm
          sessionId={sessionId}
          onClose={() => setNewMotion(false)}
          onSent={() => {
            setNewMotion(false)
            setNotice('Pedido enviado para a sessão. A animação aparece aqui quando o Claude gravar o arquivo.')
          }}
        />
      )}
      {list.length === 0 ? (
        <div className={`muted ${styles.centered}`}>
          Nenhum artifact ainda. Arquivos .html, .svg, .md, .mermaid e .motion.json escritos pelo agente aparecem aqui —
          ou arraste um arquivo para cá.
        </div>
      ) : (
        <>
          <ul className={styles.artifactList}>
            {list.map((a) => (
              <li key={a.id}>
                <button
                  className={`${styles.artifactItem} ${a.id === selected?.id ? styles.artifactItemActive : ''}`}
                  onClick={() => select(a.id)}
                >
                  <span className={styles.kind}>{KIND_LABEL[a.kind]}</span>
                  <span className={styles.ellipsis}>{a.name}</span>
                  <span className={`muted ${styles.when}`}>{ago(a.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected?.kind === 'motion' ? (
            <MotionArtifact
              key={selected.id}
              artifact={selected}
              sessionId={sessionId}
              version={version}
              onReload={() => setVersion((v) => v + 1)}
            />
          ) : (
            selected && (
              <Viewer
                key={selected.id}
                artifact={selected}
                version={version}
                onReload={() => setVersion((v) => v + 1)}
              />
            )
          )}
        </>
      )}
    </div>
  )
}

/** Side-panel tab: rendered artifacts (HTML/SVG/Markdown) produced in the session. */
export function ArtifactsPanel({ session }: { session: Session }) {
  return <SessionArtifacts key={session.id} session={session} />
}
