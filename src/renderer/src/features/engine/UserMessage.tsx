import { memo, useEffect, useState, type ReactNode } from 'react'
import { ENGINE, type ForkResult, type RewindPreview, type RewindResult, type TranscriptEntry } from '@shared/features/engine'
import { bridge } from '../../core/api'
import { savedImageUrl } from './pasted'
import styles from './engine.module.css'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Highlights `@path` / `@"path with spaces"` mentions. */
function withMentions(text: string): ReactNode[] {
  return text.split(/((?<=^|\s)@(?:"[^"]+"|[^\s"]+))/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={styles.mention}>
        {part}
      </span>
    ) : (
      part
    )
  )
}

function Thumb({ path, onOpen }: { path: string; onOpen(url: string): void }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let alive = true
    void savedImageUrl(path).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [path])
  if (!url) return <span className={`${styles.thumb} ${styles.thumbMissing}`}>🖼</span>
  return (
    <button className={styles.thumbWrap} onClick={() => onOpen(url)} title="Ver imagem">
      <img className={styles.thumb} src={url} alt="Imagem enviada" />
    </button>
  )
}

function RewindPanel({
  sessionId,
  entry,
  onDone,
  onCancel,
  onError
}: {
  sessionId: string
  entry: UserEntry
  onDone(result: RewindResult): void
  onCancel(): void
  onError(message: string): void
}) {
  const [preview, setPreview] = useState<RewindPreview>()
  const [restoreFiles, setRestoreFiles] = useState(true)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let alive = true
    bridge.invoke<RewindPreview>(ENGINE.rewindPreview, sessionId, entry.id).then(
      (p) => alive && setPreview(p),
      (err) => alive && setPreview({ canRewindConversation: false, canRewindFiles: false, filesChanged: [], filesError: errorText(err) })
    )
    return () => {
      alive = false
    }
  }, [sessionId, entry.id])

  const files = preview?.filesChanged ?? []
  const confirm = async () => {
    setWorking(true)
    try {
      const result = await bridge.invoke<RewindResult>(ENGINE.rewind, sessionId, entry.id, {
        restoreFiles: restoreFiles && files.length > 0
      })
      onDone(result)
    } catch (err) {
      onError(errorText(err))
      setWorking(false)
    }
  }

  return (
    <div className={styles.rewindPanel}>
      <div className={styles.permTitle}>Voltar a conversa para antes desta mensagem?</div>
      <div className="muted">
        Esta mensagem e tudo o que veio depois saem da conversa. O texto volta para o campo de mensagem, para você editar e reenviar.
      </div>
      {!preview ? (
        <div className={styles.working}>
          <span className={styles.spinner} /> Verificando mudanças em arquivos…
        </div>
      ) : !preview.canRewindConversation ? (
        <div className={styles.error}>{preview.filesError ?? 'Não é possível voltar a partir desta mensagem.'}</div>
      ) : preview.canRewindFiles && files.length > 0 ? (
        <label className={styles.rewindFiles}>
          <input type="checkbox" checked={restoreFiles} onChange={(e) => setRestoreFiles(e.target.checked)} />
          <span>
            Desfazer também as mudanças em {files.length === 1 ? '1 arquivo' : `${files.length} arquivos`}
            {preview.insertions !== undefined && (
              <span className="muted">
                {' '}
                (+{preview.insertions} −{preview.deletions ?? 0})
              </span>
            )}
            <span className={styles.rewindFileList}>{files.map(basename).join(', ')}</span>
          </span>
        </label>
      ) : (
        <div className="muted">
          {preview.canRewindFiles
            ? 'Nenhuma mudança em arquivos registrada a partir daqui.'
            : `Mudanças em arquivos não podem ser desfeitas automaticamente${preview.filesError ? ` (${preview.filesError})` : ''}.`}
        </div>
      )}
      <div className={styles.permReason}>Comandos de terminal (Bash/PowerShell) e edições de subagentes não são desfeitos.</div>
      <div className={styles.permActions}>
        <button className="btn btn-primary" disabled={!preview?.canRewindConversation || working} onClick={() => void confirm()}>
          {working ? 'Voltando…' : 'Voltar para aqui'}
        </button>
        <button className="btn" onClick={onCancel} disabled={working}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

interface Props {
  entry: UserEntry
  sessionId: string
  busy: boolean
  onRewound(result: RewindResult): void
  onError(message: string): void
  onOpenImage(url: string): void
}

export const UserMessage = memo(function UserMessage({ entry, sessionId, busy, onRewound, onError, onOpenImage }: Props) {
  const [rewinding, setRewinding] = useState(false)
  const [forking, setForking] = useState(false)

  const fork = async () => {
    setForking(true)
    try {
      // Main selects the new session (engine:event:select).
      await bridge.invoke<ForkResult>(ENGINE.fork, sessionId, entry.id)
    } catch (err) {
      onError(errorText(err))
    } finally {
      setForking(false)
    }
  }

  return (
    <div className={styles.userRow}>
      <div className={styles.user}>
        {entry.images?.length ? (
          <div className={styles.attachments}>
            {entry.images.map((p) => (
              <Thumb key={p} path={p} onOpen={onOpenImage} />
            ))}
          </div>
        ) : null}
        {entry.output === 'motion' && (
          <span className={styles.motionBadge} title="Enviada com Saída: Motion">
            🎬 Motion
          </span>
        )}
        {entry.text && <div className={styles.userText}>{withMentions(entry.text)}</div>}
        {entry.attachments?.length ? (
          <div className={styles.attachments}>
            {entry.attachments.map((a) => (
              <span key={a} className={styles.chip} title={a}>
                📎 {basename(a)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {!rewinding && (
        <div className={styles.userActions}>
          <button
            className={styles.userAction}
            disabled={busy}
            title={busy ? 'Pare a geração primeiro' : 'Descarta esta mensagem e as seguintes e devolve o texto para edição'}
            onClick={() => setRewinding(true)}
          >
            ✎ Editar e reenviar daqui
          </button>
          <button
            className={styles.userAction}
            disabled={busy || forking}
            title={busy ? 'Pare a geração primeiro' : 'Nova sessão com a conversa até esta mensagem e a resposta dela'}
            onClick={() => void fork()}
          >
            ⑂ {forking ? 'Bifurcando…' : 'Bifurcar daqui'}
          </button>
        </div>
      )}
      {rewinding && (
        <RewindPanel
          sessionId={sessionId}
          entry={entry}
          onDone={onRewound}
          onCancel={() => setRewinding(false)}
          onError={onError}
        />
      )}
    </div>
  )
})
