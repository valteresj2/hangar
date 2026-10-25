// "Servidores" dropdown of the BrowserPanel: configurations from .claude/launch.json,
// start/stop, live log, and an editor to create or change the file.
import { useEffect, useRef, useState } from 'react'
import { PREVIEW, type ServerInfo } from '@shared/features/preview'
import { bridge } from '../../core/api'
import { previewApi, useLaunchConfigs, useServerLog } from './servers'
import { useBrowser } from './store'
import styles from './preview.module.css'

const TEMPLATE = `{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "dev",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 5173
    }
  ]
}
`

const STATUS_LABEL: Record<ServerInfo['status'], string> = {
  starting: 'Iniciando…',
  running: 'Rodando',
  stopping: 'Parando…',
  exited: 'Encerrado',
  error: 'Erro'
}

function isAlive(server?: ServerInfo): boolean {
  return server?.status === 'starting' || server?.status === 'running'
}

function LogView({ serverId }: { serverId: string }) {
  const log = useServerLog(serverId)
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <pre
      ref={ref}
      className={styles.log}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {log || 'Sem saída ainda.'}
    </pre>
  )
}

function Editor({
  sessionId,
  initial,
  exists,
  onDone
}: {
  sessionId: string
  initial: string
  exists: boolean
  onDone(saved: boolean): void
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)

  const save = async (overwrite: boolean) => {
    setError(undefined)
    const res = await bridge.invoke(PREVIEW.launchSave, sessionId, text, overwrite)
    if (res.ok) return onDone(true)
    if (res.exists) setConfirming(true)
    else setError(res.error)
  }

  return (
    <div className={styles.editor}>
      <textarea
        className={`input ${styles.editorText}`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className={styles.errorText}>{error}</div>}
      {confirming ? (
        <div className={styles.confirm}>
          <span>
            O arquivo <code>.claude/launch.json</code> já existe. Sobrescrever?
          </span>
          <button className="btn btn-primary" onClick={() => void save(true)}>
            Sobrescrever
          </button>
          <button className="btn" onClick={() => setConfirming(false)}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <button className="btn btn-primary" onClick={() => void save(false)}>
            {exists ? 'Salvar…' : 'Criar arquivo'}
          </button>
          <button className="btn" onClick={() => onDone(false)}>
            Cancelar
          </button>
          {!text.trim() && (
            <button className="btn" onClick={() => setText(TEMPLATE)}>
              Usar modelo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ServersMenu({
  sessionId,
  servers,
  onClose
}: {
  sessionId: string
  servers: ServerInfo[]
  onClose(): void
}) {
  const { data, reload } = useLaunchConfigs(sessionId)
  const [editing, setEditing] = useState(false)
  const [logFor, setLogFor] = useState<string>()
  const [startError, setStartError] = useState<string>()
  const openTab = useBrowser((s) => s.openTab)

  const byName = new Map(servers.map((s) => [s.name, s]))
  const selectedLog = logFor ? servers.find((s) => s.id === logFor) : undefined

  const start = async (name: string) => {
    setStartError(undefined)
    try {
      const server = await previewApi.start(sessionId, name)
      setLogFor(server.id)
    } catch (err) {
      setStartError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className={styles.menu} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className={styles.menuHeader}>
        <strong>Servidores</strong>
        <span className={`muted ${styles.ellipsis}`} title={data?.path}>
          .claude/launch.json
        </span>
        <div className={styles.flex} />
        {!editing && (
          <>
            <button className="btn" onClick={reload} title="Ler o launch.json de novo">
              ⟳
            </button>
            <button className="btn" onClick={() => setEditing(true)}>
              {data?.exists ? 'Editar launch.json' : 'Criar launch.json'}
            </button>
          </>
        )}
        <button className="icon-btn" title="Fechar" onClick={onClose}>
          ✕
        </button>
      </div>

      {editing ? (
        <Editor
          sessionId={sessionId}
          initial={data?.text ?? TEMPLATE}
          exists={!!data?.exists}
          onDone={(saved) => {
            setEditing(false)
            if (saved) reload()
          }}
        />
      ) : (
        <>
          {data?.error && <div className={styles.errorText}>{data.error}</div>}
          {startError && <div className={styles.errorText}>{startError}</div>}
          {data && !data.exists && (
            <div className="muted">
              Nenhum <code>.claude/launch.json</code> nesta pasta. Crie um para iniciar servidores de desenvolvimento
              daqui.
            </div>
          )}
          {data?.configurations.map((config) => {
            const server = byName.get(config.name)
            const alive = isAlive(server)
            return (
              <div key={config.name} className={styles.serverRow}>
                <span className={`${styles.dot} ${server ? styles[`dot_${server.status}`] : ''}`} />
                <div className={styles.serverInfo}>
                  <div className={styles.ellipsis}>
                    <strong>{config.name}</strong>
                    {server && <span className="muted"> · {STATUS_LABEL[server.status]}</span>}
                  </div>
                  <code className={`muted ${styles.ellipsis}`}>
                    {[config.runtimeExecutable, ...(config.runtimeArgs ?? [])].join(' ')}
                    {config.port ? ` · :${config.port}` : ''}
                  </code>
                </div>
                {server && (
                  <button className="btn" onClick={() => setLogFor(logFor === server.id ? undefined : server.id)}>
                    Log
                  </button>
                )}
                {server?.status === 'running' && server.url && (
                  <button className="btn" onClick={() => openTab(sessionId, server.url)}>
                    Abrir
                  </button>
                )}
                {alive || server?.status === 'stopping' ? (
                  <button
                    className="btn"
                    disabled={server?.status === 'stopping'}
                    onClick={() => server && void previewApi.stop(server.id)}
                  >
                    Parar
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => void start(config.name)}>
                    Iniciar
                  </button>
                )}
              </div>
            )
          })}
          {selectedLog && (
            <div className={styles.logBox}>
              <div className={styles.logHeader}>
                <span>
                  Log — <strong>{selectedLog.name}</strong>
                  {selectedLog.pid ? <span className="muted"> · PID {selectedLog.pid}</span> : null}
                </span>
                <button className="icon-btn" title="Fechar log" onClick={() => setLogFor(undefined)}>
                  ✕
                </button>
              </div>
              <LogView serverId={selectedLog.id} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
