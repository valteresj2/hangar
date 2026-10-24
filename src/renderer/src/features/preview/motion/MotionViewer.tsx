// Viewer of a `*.motion.json` artifact: player, embedded editor and MP4 export.
// The file is polled for changes; without unsaved edits it reloads in place (keeping the playhead),
// with unsaved edits the user decides.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseMotion, type MotionSpec } from '@shared/motion/spec'
import { imageSources, loadMotionAssets, type MotionAssets } from '@renderer/motion/runtime'
import { PREVIEW, type Artifact, type ArtifactContent, type ArtifactStat, type ArtifactWriteResult, type MotionAssetUrls } from '@shared/features/preview'
import { bridge } from '../../../core/api'
import { Editor } from './Editor'
import type { Edit } from './ElementForm'
import { ExportCancelled, exportMp4 } from './exportMp4'
import { settledTime } from './geometry'
import { useHistory } from './history'
import { Player, type DragPhase, type PlayerController } from './Player'
import styles from './motion.module.css'

const POLL_MS = 1200

type ExportState =
  | { state: 'running'; frame: number; total: number; path: string; controller: AbortController }
  | { state: 'done'; path: string }
  | { state: 'error'; error: string }

function errorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Gives scenes/elements without an id the same ids parseMotion would, so the editor can address them. */
function ensureIds(doc: MotionSpec): MotionSpec {
  doc.scenes.forEach((s, i) => {
    if (typeof s.id !== 'string') s.id = `scene${i + 1}`
    if (!Array.isArray(s.elements)) s.elements = []
    s.elements.forEach((e, j) => {
      if (typeof e.id !== 'string') e.id = `s${i + 1}e${j + 1}`
    })
  })
  return doc
}

export function MotionViewer({ artifact, sessionId }: { artifact: Artifact; sessionId: string }) {
  const history = useHistory<MotionSpec | null>(null)
  const doc = history.value
  const [saved, setSaved] = useState<MotionSpec | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sel, setSel] = useState<{ scene: number; element?: string }>({ scene: 0 })
  const [diskChanged, setDiskChanged] = useState(false)
  const [assets, setAssets] = useState<MotionAssets>(() => new Map())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [exp, setExp] = useState<ExportState>()
  const player = useRef<PlayerController>(null)
  const knownMtime = useRef(0)
  const docRef = useRef(doc)
  docRef.current = doc
  const dirty = !!doc && doc !== saved
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const dragSeq = useRef(0)

  const load = useCallback(async () => {
    try {
      const data = await bridge.invoke<ArtifactContent>(PREVIEW.artifactRead, artifact.path)
      knownMtime.current = data.mtime
      setLoadError(undefined)
      setDiskChanged(false)
      const v = parseMotion(data.content)
      if (!v.spec) {
        setFileErrors(v.errors)
        history.reset(null)
        setSaved(null)
      } else {
        const raw = ensureIds(JSON.parse(data.content) as MotionSpec)
        setFileErrors([])
        history.reset(raw)
        setSaved(raw)
      }
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setLoaded(true)
    }
  }, [artifact.path, history.reset])

  useEffect(() => {
    void load()
  }, [load])

  // Watch the file: the agent (or anything else) may rewrite it while it is open.
  const checkDisk = useCallback(async () => {
    const stat = await bridge.invoke<ArtifactStat>(PREVIEW.artifactStat, artifact.id).catch(() => undefined)
    if (!stat?.exists || stat.mtime === knownMtime.current) return
    if (dirtyRef.current) {
      knownMtime.current = stat.mtime
      setDiskChanged(true)
    } else {
      void load()
    }
  }, [artifact.id, load])

  useEffect(() => {
    const timer = setInterval(() => void checkDisk(), POLL_MS)
    return () => clearInterval(timer)
  }, [checkDisk])

  useEffect(() => {
    void checkDisk()
  }, [artifact.updatedAt, checkDisk])

  // Current edits validated with the same parser the agent's file goes through; keep the last good spec on screen.
  const parsed = useMemo(() => (doc ? parseMotion(JSON.stringify(doc)) : undefined), [doc])
  const lastGood = useRef<MotionSpec>(undefined)
  if (parsed?.spec) lastGood.current = parsed.spec
  if (!doc) lastGood.current = undefined
  const spec = lastGood.current

  // Images: local files come as data: URLs from main (the app CSP blocks file: and loopback images).
  const srcKey = spec ? imageSources(spec).join('\n') : ''
  const specRef = useRef(spec)
  specRef.current = spec
  useEffect(() => {
    const current = specRef.current
    if (!current) return
    let alive = true
    void (async () => {
      const srcs = imageSources(current)
      const urls = srcs.length ? await bridge.invoke<MotionAssetUrls>(PREVIEW.motionAssets, artifact.id, srcs).catch(() => ({}) as MotionAssetUrls) : {}
      const loadedAssets = await loadMotionAssets(current, (src) => urls[src] ?? src)
      if (alive) setAssets(loadedAssets)
    })()
    return () => {
      alive = false
    }
  }, [srcKey, artifact.id])

  const edit: Edit = useCallback(
    (mutate, key) => {
      const cur = docRef.current
      if (!cur) return
      const next = structuredClone(cur)
      mutate(next)
      history.set(next, key)
    },
    [history.set]
  )

  const save = useCallback(async () => {
    const cur = docRef.current
    if (!cur || saving) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const res = await bridge.invoke<ArtifactWriteResult>(PREVIEW.artifactWrite, artifact.id, `${JSON.stringify(cur, null, 2)}\n`)
      knownMtime.current = res.mtime
      setSaved(cur)
      setDiskChanged(false)
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [artifact.id, saving])

  const onDrag = useCallback(
    (id: string, x: number, y: number, phase: DragPhase) => {
      if (phase === 'end') return
      if (phase === 'start') dragSeq.current++
      edit((d) => {
        for (const s of d.scenes) {
          const el = s.elements.find((e) => e.id === id)
          if (el) {
            el.x = x
            el.y = y
          }
        }
      }, `drag:${id}:${dragSeq.current}`)
    },
    [edit]
  )

  const selectScene = (index: number) => {
    setSel({ scene: index })
    if (spec) player.current?.seek(settledTime(spec, index))
  }
  const selectElement = (sceneIndex: number, id: string | undefined) => {
    setSel({ scene: sceneIndex, element: id })
    const el = spec?.scenes[sceneIndex]?.elements.find((e) => e.id === id)
    if (spec && el) player.current?.seek(settledTime(spec, sceneIndex, el))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 's' && doc) {
      e.preventDefault()
      void save()
    } else if (editing && k === 'z' && !e.shiftKey) {
      e.preventDefault()
      history.undo()
    } else if (editing && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault()
      history.redo()
    }
  }

  const startExport = async () => {
    if (!spec) return
    player.current?.pause()
    const path = await bridge.invoke<string | undefined>(PREVIEW.exportDialog, sessionId, spec.title)
    if (!path) return
    const controller = new AbortController()
    setExp({ state: 'running', frame: 0, total: 1, path, controller })
    try {
      await exportMp4({
        spec,
        assets,
        path,
        signal: controller.signal,
        onProgress: (frame, total) => setExp((e) => (e?.state === 'running' ? { ...e, frame, total } : e))
      })
      setExp({ state: 'done', path })
    } catch (err) {
      if (err instanceof ExportCancelled) setExp(undefined)
      else setExp({ state: 'error', error: errorMessage(err) })
    }
  }

  if (!loaded) return <div className={`muted ${styles.centered}`}>Carregando…</div>
  if (loadError) return <div className={styles.errorBox}>{loadError}</div>
  if (!doc || !spec) {
    return (
      <div className={styles.errorBox}>
        <strong>Este arquivo Motion tem erros:</strong>
        <ul>
          {fileErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <span className="muted">Corrija o arquivo (ou peça ao Claude); ele recarrega sozinho.</span>
      </div>
    )
  }

  const sceneIndex = Math.min(sel.scene, doc.scenes.length - 1)
  const editErrors = parsed?.errors ?? []

  return (
    <div className={`${styles.viewer} ${editing ? styles.viewerEditing : ''}`} onKeyDown={onKeyDown}>
      {diskChanged && (
        <div className={styles.banner}>
          <span>O arquivo mudou no disco e você tem edições não salvas.</span>
          <button className="btn" onClick={() => void load()}>
            Recarregar do disco
          </button>
          <button className="btn" onClick={() => setDiskChanged(false)}>
            Manter minhas edições
          </button>
        </div>
      )}
      <div className={styles.playerArea}>
        <Player
          spec={spec}
          assets={assets}
          editing={editing}
          selectedId={sel.element}
          controllerRef={player}
          onSelect={(hit) => setSel((s) => (hit ? { scene: hit.sceneIndex, element: hit.elementId } : { scene: s.scene }))}
          onDrag={onDrag}
          actions={
            <>
              {editing && (
                <>
                  <button className="icon-btn" title="Desfazer (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>
                    ↶
                  </button>
                  <button className="icon-btn" title="Refazer (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}>
                    ↷
                  </button>
                </>
              )}
              {dirty && (
                <button className="btn btn-primary" disabled={saving} title="Salvar (Ctrl+S)" onClick={() => void save()}>
                  {saving ? 'Salvando…' : 'Salvar'}
                </button>
              )}
              <button className={`btn ${editing ? styles.toggleOn : ''}`} onClick={() => setEditing((v) => !v)}>
                {editing ? 'Concluir edição' : 'Editar'}
              </button>
              <button className="btn" onClick={() => void startExport()} disabled={exp?.state === 'running'}>
                Exportar MP4
              </button>
            </>
          }
        />
      </div>
      {saveError && <div className={styles.errorStrip}>Não foi possível salvar: {saveError}</div>}
      {editing && editErrors.length > 0 && (
        <div className={styles.errorStrip}>
          A edição atual é inválida (mostrando a última versão válida): {editErrors.join(' · ')}
        </div>
      )}
      {editing && (
        <div className={styles.editorArea}>
          <Editor
            doc={doc}
            edit={edit}
            sceneIndex={sceneIndex}
            elementId={sel.element}
            onSelectScene={selectScene}
            onSelectElement={selectElement}
          />
        </div>
      )}

      {exp && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal} role="dialog" aria-label="Exportar MP4">
            <strong>Exportar MP4</strong>
            {exp.state === 'running' && (
              <>
                <div className={`muted ${styles.ellipsis}`} title={exp.path}>
                  {exp.path}
                </div>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${(exp.frame / exp.total) * 100}%` }} />
                </div>
                <div className={styles.modalRow}>
                  <span className="muted">
                    Quadro {exp.frame} de {exp.total} ({Math.round((exp.frame / exp.total) * 100)}%)
                  </span>
                  <div className={styles.flex} />
                  <button className="btn" onClick={() => exp.controller.abort()}>
                    Cancelar
                  </button>
                </div>
              </>
            )}
            {exp.state === 'done' && (
              <>
                <div>Vídeo exportado:</div>
                <div className={`muted ${styles.breakAll}`}>{exp.path}</div>
                <div className={styles.modalRow}>
                  <div className={styles.flex} />
                  <button className="btn" onClick={() => void bridge.invoke(PREVIEW.showInFolder, exp.path)}>
                    Mostrar na pasta
                  </button>
                  <button className="btn btn-primary" onClick={() => setExp(undefined)}>
                    Fechar
                  </button>
                </div>
              </>
            )}
            {exp.state === 'error' && (
              <>
                <div className={styles.errorText}>{exp.error}</div>
                <div className={styles.modalRow}>
                  <div className={styles.flex} />
                  <button className="btn" onClick={() => setExp(undefined)}>
                    Fechar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
