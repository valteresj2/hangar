// Modal dialogs and toasts of the sessions feature. <SessionsOverlay/> is mounted by whichever of
// NewSessionView / SessionHeader is on screen (exactly one of them always is), so dialogs opened from the
// sidebar keep working even when the sidebar is hidden.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '@shared/contracts'
import {
  OPEN_CHATGPT_IMPORT_EVENT,
  OPEN_IMPORT_EVENT,
  type ChatgptProjectInfo,
  type ChatgptScan,
  type CliSessionInfo
} from '@shared/features/sessions'
import { api } from '../../core/api'
import { useCollection } from '../../core/data'
import {
  createGroup,
  deleteGroup,
  deleteProject,
  deleteSession,
  importChatgpt,
  importCliSessions,
  listChatgpt,
  listCliSessions,
  moveToGroup,
  renameGroup,
  saveProject
} from './actions'
import { useSessionsUi, type SessionsDialog } from './store'
import { errorText, relativeTime, shortFolder } from './util'
import styles from './sessions.module.css'

function Modal({
  title,
  children,
  onClose,
  wide
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`${styles.modal} ${wide ? styles.modalWide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.modalTitle}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className={styles.modalActions}>{children}</div>
}

function NameDialog(props: {
  title: string
  label: string
  initial?: string
  confirm: string
  onSubmit: (name: string) => Promise<unknown>
  onClose: () => void
}) {
  const [name, setName] = useState(props.initial ?? '')
  const submit = async () => {
    if (!name.trim()) return
    await props.onSubmit(name)
    props.onClose()
  }
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <label className={styles.field}>
        <span>{props.label}</span>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <Actions>
        <button className="btn" onClick={props.onClose}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>
          {props.confirm}
        </button>
      </Actions>
    </Modal>
  )
}

function ConfirmDialog(props: {
  title: string
  message: ReactNode
  confirm: string
  onConfirm: () => Promise<unknown>
  onClose: () => void
  children?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className={styles.modalBody}>{props.message}</div>
      {props.children}
      <Actions>
        <button className="btn" onClick={props.onClose}>
          Cancelar
        </button>
        <button
          className={`btn ${styles.btnDanger}`}
          autoFocus
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true)
              await props.onConfirm()
              props.onClose()
            })()
          }
        >
          {busy ? 'Aguarde…' : props.confirm}
        </button>
      </Actions>
    </Modal>
  )
}

function ProjectDialog({ project, onClose }: { project?: Project; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [cwd, setCwd] = useState(project?.cwd ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const valid = name.trim() && cwd.trim()

  const pick = async () => {
    const folder = await api.pickFolder(cwd || undefined)
    if (!folder) return
    setCwd(folder)
    if (!name.trim()) setName(shortFolder(folder))
  }

  const submit = async () => {
    if (!valid) return
    const saved = await saveProject(
      { name: name.trim(), cwd: cwd.trim(), instructions: instructions.trim() || undefined },
      project
    )
    if (saved) onClose()
  }

  return (
    <Modal title={project ? 'Editar projeto' : 'Novo projeto'} onClose={onClose}>
      <label className={styles.field}>
        <span>Nome</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span>Pasta</span>
        <div className={styles.row}>
          <input
            className="input"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\caminho\do\projeto"
          />
          <button className="btn" onClick={() => void pick()}>
            Escolher…
          </button>
        </div>
      </label>
      <label className={styles.field}>
        <span>Instruções</span>
        <textarea
          className={`input ${styles.textarea}`}
          rows={5}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Contexto e regras anexados ao prompt de sistema de toda sessão deste projeto"
        />
      </label>
      <Actions>
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => void submit()}>
          {project ? 'Salvar' : 'Criar projeto'}
        </button>
      </Actions>
    </Modal>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<CliSessionInfo[]>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    listCliSessions()
      .then((r) => alive && setRows(r))
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (rows ?? []).filter((r) => !q || r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q))
  }, [rows, filter])
  const importable = visible.filter((r) => !r.imported)
  const allChecked = importable.length > 0 && importable.every((r) => selected.has(r.sdkSessionId))

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const r of importable) {
        if (allChecked) next.delete(r.sdkSessionId)
        else next.add(r.sdkSessionId)
      }
      return next
    })

  const submit = async () => {
    setBusy(true)
    const res = await importCliSessions([...selected])
    setBusy(false)
    if (res) onClose()
  }

  return (
    <Modal title="Importar sessões do CLI claude" onClose={onClose} wide>
      <div className={styles.modalBody}>
        <span className="muted">
          Sessões encontradas em %USERPROFILE%\.claude\projects. Ao abrir, a conversa é retomada.
        </span>
      </div>
      <div className={styles.row}>
        <input
          className="input"
          placeholder="Filtrar por título ou pasta"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn" disabled={!importable.length} onClick={toggleAll}>
          {allChecked ? 'Desmarcar todas' : 'Marcar todas'}
        </button>
      </div>
      <div className={styles.importList}>
        {error && <div className={styles.importEmpty}>Não foi possível ler as sessões: {error}</div>}
        {!error && !rows && <div className={styles.importEmpty}>Procurando sessões…</div>}
        {rows && visible.length === 0 && <div className={styles.importEmpty}>Nenhuma sessão encontrada.</div>}
        {visible.map((r) => (
          <label
            key={r.sdkSessionId}
            className={`${styles.importRow} ${r.imported ? styles.importDone : ''}`}
            title={r.cwd}
          >
            <input
              type="checkbox"
              disabled={r.imported}
              checked={r.imported || selected.has(r.sdkSessionId)}
              onChange={() => toggle(r.sdkSessionId)}
            />
            <span className={styles.importMain}>
              <span className={styles.importTitle}>{r.title}</span>
              <span className={styles.importMeta}>
                {shortFolder(r.cwd)} · {relativeTime(r.updatedAt)} · {r.messages} mensagens
                {r.imported ? ' · já importada' : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
      <Actions>
        <span className="muted">
          {selected.size ? `${selected.size} selecionada${selected.size > 1 ? 's' : ''}` : ''}
        </span>
        <div className={styles.spacer} />
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!selected.size || busy} onClick={() => void submit()}>
          {busy ? 'Importando…' : 'Importar'}
        </button>
      </Actions>
    </Modal>
  )
}

/** Projects of the ChatGPT desktop app, each with its conversations; a conversation brings its project along. */
function ChatgptImportDialog({ onClose }: { onClose: () => void }) {
  const [scan, setScan] = useState<ChatgptScan>()
  const [error, setError] = useState<string>()
  const [projects, setProjects] = useState<Set<string>>(new Set())
  const [threads, setThreads] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    listChatgpt()
      .then((r) => alive && setScan(r))
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: string) => s.toLowerCase().includes(q)
    return (scan?.projects ?? []).flatMap((p) => {
      if (!q || match(p.name) || match(p.cwd)) return [p]
      const hits = p.threads.filter((t) => match(t.title))
      return hits.length ? [{ ...p, threads: hits }] : []
    })
  }, [scan, filter])

  const pending = (p: ChatgptProjectInfo) => p.threads.filter((t) => !t.imported)
  const importable = (p: ChatgptProjectInfo) => p.exists && (!p.imported || pending(p).length > 0)
  const projectChecked = (p: ChatgptProjectInfo) => projects.has(p.key) || p.threads.some((t) => threads.has(t.id))
  const allChecked =
    visible.some(importable) &&
    visible.filter(importable).every((p) => projectChecked(p) && pending(p).every((t) => threads.has(t.id)))

  const setProject = (p: ChatgptProjectInfo, on: boolean) => {
    setProjects((prev) => {
      const next = new Set(prev)
      if (on) next.add(p.key)
      else next.delete(p.key)
      return next
    })
    setThreads((prev) => {
      const next = new Set(prev)
      for (const t of pending(p)) {
        if (on) next.add(t.id)
        else next.delete(t.id)
      }
      return next
    })
  }

  const toggleThread = (id: string) =>
    setThreads((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () => {
    for (const p of visible) if (importable(p)) setProject(p, !allChecked)
  }

  const chosenProjects = (scan?.projects ?? []).filter((p) => !p.imported && p.exists && projectChecked(p)).length
  const submit = async () => {
    setBusy(true)
    const res = await importChatgpt({ projects: [...projects], threads: [...threads] })
    setBusy(false)
    if (res) onClose()
  }

  const metaOf = (p: ChatgptProjectInfo) =>
    [
      shortFolder(p.cwd),
      `${p.threads.length} conversa${p.threads.length === 1 ? '' : 's'}`,
      p.agentsMd ? 'com AGENTS.md' : '',
      !p.exists ? 'pasta não encontrada' : p.imported ? 'projeto já importado' : ''
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <Modal title="Importar projetos do ChatGPT" onClose={onClose} wide>
      <div className={styles.modalBody}>
        <span className="muted">
          Projetos e conversas do app ChatGPT (Work e Codex) neste computador. Cada projeto vira um projeto do Hangar na
          mesma pasta; cada conversa vira uma sessão com o histórico, e o modelo recebe a conversa como contexto ao
          continuar.
        </span>
      </div>
      <div className={styles.row}>
        <input
          className="input"
          placeholder="Filtrar por projeto, pasta ou conversa"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn" disabled={!visible.some(importable)} onClick={toggleAll}>
          {allChecked ? 'Desmarcar tudo' : 'Marcar tudo'}
        </button>
      </div>
      <div className={styles.importList}>
        {error && <div className={styles.importEmpty}>Não foi possível ler os dados do ChatGPT: {error}</div>}
        {!error && !scan && <div className={styles.importEmpty}>Procurando projetos…</div>}
        {scan && !scan.found && (
          <div className={styles.importEmpty}>
            Não encontramos o app ChatGPT neste computador (procuramos em {scan.dir}).
          </div>
        )}
        {scan?.found && visible.length === 0 && <div className={styles.importEmpty}>Nenhum projeto encontrado.</div>}
        {visible.map((p) => (
          <div key={p.key}>
            <label
              className={`${styles.importRow} ${styles.importProject} ${importable(p) ? '' : styles.importDone}`}
              title={p.cwd}
            >
              <input
                type="checkbox"
                aria-label={`Projeto ${p.name}`}
                disabled={!importable(p)}
                checked={(p.imported && p.exists) || projectChecked(p)}
                onChange={(e) => setProject(p, e.target.checked)}
              />
              <span className={styles.importMain}>
                <span className={styles.importTitle}>{p.name}</span>
                <span className={styles.importMeta}>{metaOf(p)}</span>
              </span>
            </label>
            {p.threads.map((t) => (
              <label
                key={t.id}
                className={`${styles.importRow} ${styles.importThread} ${t.imported || !p.exists ? styles.importDone : ''}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Conversa ${t.title}`}
                  disabled={t.imported || !p.exists}
                  checked={t.imported || threads.has(t.id)}
                  onChange={() => toggleThread(t.id)}
                />
                <span className={styles.importMain}>
                  <span className={styles.importTitle}>{t.title}</span>
                  <span className={styles.importMeta}>
                    {relativeTime(t.updatedAt)}
                    {t.messages ? ` · ${t.messages} mensagens` : ''}
                    {t.imported ? ' · já importada' : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <Actions>
        <span className="muted">
          {[
            chosenProjects ? `${chosenProjects} projeto${chosenProjects > 1 ? 's' : ''}` : '',
            threads.size ? `${threads.size} conversa${threads.size > 1 ? 's' : ''}` : ''
          ]
            .filter(Boolean)
            .join(' e ')}
        </span>
        <div className={styles.spacer} />
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="btn btn-primary"
          disabled={(!chosenProjects && !threads.size) || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Importando…' : 'Importar'}
        </button>
      </Actions>
    </Modal>
  )
}

function DeleteSessionDialog({
  dialog,
  onClose
}: {
  dialog: Extract<SessionsDialog, { kind: 'delete' }>
  onClose: () => void
}) {
  const { session } = dialog
  const [removeWt, setRemoveWt] = useState(false)
  return (
    <ConfirmDialog
      title="Excluir sessão"
      message={
        <>
          Excluir <b>{session.title}</b>? A sessão sai do Hangar; os arquivos da pasta não são tocados.
        </>
      }
      confirm="Excluir"
      onConfirm={() => deleteSession(session, removeWt)}
      onClose={onClose}
    >
      {session.worktree && (
        <label className={styles.check}>
          <input type="checkbox" checked={removeWt} onChange={(e) => setRemoveWt(e.target.checked)} />
          <span>
            Remover também a pasta do worktree <code>{session.worktree.branch}</code>
            <span className={styles.checkHint}>{session.worktree.path}</span>
          </span>
        </label>
      )}
    </ConfirmDialog>
  )
}

function DialogSwitch({ dialog }: { dialog: SessionsDialog }) {
  const close = useSessionsUi((s) => s.closeDialog)
  const groups = useCollection('groups')
  const sessions = useCollection('sessions')

  switch (dialog.kind) {
    case 'delete':
      return <DeleteSessionDialog dialog={dialog} onClose={close} />
    case 'newGroup':
      return (
        <NameDialog
          title="Novo grupo"
          label="Nome do grupo"
          confirm="Criar"
          onClose={close}
          onSubmit={async (name) => {
            const group = await createGroup(name, groups)
            if (group && dialog.moveSessionId) await moveToGroup(dialog.moveSessionId, group.id)
          }}
        />
      )
    case 'renameGroup':
      return (
        <NameDialog
          title="Renomear grupo"
          label="Nome do grupo"
          confirm="Salvar"
          initial={dialog.group.name}
          onClose={close}
          onSubmit={(name) => renameGroup(dialog.group, name)}
        />
      )
    case 'deleteGroup':
      return (
        <ConfirmDialog
          title="Excluir grupo"
          message={
            <>
              Excluir o grupo <b>{dialog.group.name}</b>? As sessões dele voltam para Recentes.
            </>
          }
          confirm="Excluir grupo"
          onConfirm={() => deleteGroup(dialog.group, sessions)}
          onClose={close}
        />
      )
    case 'project':
      return <ProjectDialog project={dialog.project} onClose={close} />
    case 'deleteProject':
      return (
        <ConfirmDialog
          title="Excluir projeto"
          message={
            <>
              Excluir o projeto <b>{dialog.project.name}</b>? As sessões continuam existindo, só perdem o vínculo.
            </>
          }
          confirm="Excluir projeto"
          onConfirm={() => deleteProject(dialog.project, sessions)}
          onClose={close}
        />
      )
    case 'import':
      return <ImportDialog onClose={close} />
    case 'importChatgpt':
      return <ChatgptImportDialog onClose={close} />
  }
}

function Toasts() {
  const toasts = useSessionsUi((s) => s.toasts)
  const dismiss = useSessionsUi((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className={styles.toasts}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.tone === 'error' ? styles.toastError : ''}`}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

export function SessionsOverlay() {
  const dialog = useSessionsUi((s) => s.dialog)
  const openDialog = useSessionsUi((s) => s.openDialog)

  // Other features (e.g. the command palette) open the import dialog with a DOM event.
  useEffect(() => {
    const onImport = () => openDialog({ kind: 'import' })
    const onChatgpt = () => openDialog({ kind: 'importChatgpt' })
    window.addEventListener(OPEN_IMPORT_EVENT, onImport)
    window.addEventListener(OPEN_CHATGPT_IMPORT_EVENT, onChatgpt)
    return () => {
      window.removeEventListener(OPEN_IMPORT_EVENT, onImport)
      window.removeEventListener(OPEN_CHATGPT_IMPORT_EVENT, onChatgpt)
    }
  }, [openDialog])

  // Re-key per dialog object so local form state resets between openings.
  const key = useRef(0)
  const last = useRef<SessionsDialog | undefined>(undefined)
  if (dialog !== last.current) {
    last.current = dialog
    key.current++
  }
  return createPortal(
    <>
      {dialog && <DialogSwitch key={key.current} dialog={dialog} />}
      <Toasts />
    </>,
    document.body
  )
}
