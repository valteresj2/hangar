// Landing view: choose a folder (and optionally a project / isolated worktree), model and permission mode, an
// optional name, then type the first prompt. Submitting creates the session, selects it and hands the prompt to the
// engine; with no prompt it only creates the session (named or "Nova sessão"), to be started later.
import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import type { PermissionMode, Worktree } from '@shared/contracts'
import { ENGINE } from '@shared/features/engine'
import { GIT } from '@shared/features/git'
import type { ModelChoice } from '@shared/features/platform'
import { SESSIONS, type CreateSessionInput } from '@shared/features/sessions'
import { api, bridge } from '../../core/api'
import { useCollection, useSettings } from '../../core/data'
import { useUi } from '../../core/ui'
import { ModelPicker, PlatformRequiredNotice, platformApi, useCanCreateSessions } from '../platform'
import { anchorBelow, ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { SessionsOverlay } from './Dialogs'
import { BranchIcon, FolderIcon, PinIcon } from './icons'
import { FOCUS_NEW_SESSION_EVENT, useSessionShortcuts } from './shortcuts'
import { useSessionsUi } from './store'
import { errorText, PERMISSION_LABELS, samePath, shortFolder } from './util'
import styles from './sessions.module.css'

/** Last draft nonce applied, so remounting the view doesn't re-apply an old preset. */
let appliedDraft = 0

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Boa noite'
  if (h < 12) return 'Bom dia'
  if (h < 18) return 'Boa tarde'
  return 'Boa noite'
}

export function NewSessionView() {
  useSessionShortcuts()
  const settings = useSettings()
  const projects = useCollection('projects')
  const draft = useSessionsUi((s) => s.draft)
  const showToast = useSessionsUi((s) => s.showToast)
  const canCreate = useCanCreateSessions()

  const [cwd, setCwd] = useState<string>()
  const [projectId, setProjectId] = useState<string>()
  const [isRepo, setIsRepo] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  /** Profile + model chosen here; undefined follows the defaults (Configurações → Geral). */
  const [choice, setChoice] = useState<ModelChoice>()
  const [permissionMode, setPermissionMode] = useState<PermissionMode>()
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [folderMenu, setFolderMenu] = useState<MenuAnchor>()
  const textRef = useRef<HTMLTextAreaElement>(null)

  // Apply a preset coming from the sidebar ("Nova sessão neste projeto"), once.
  useEffect(() => {
    if (draft.nonce <= appliedDraft) return
    appliedDraft = draft.nonce
    if (draft.cwd) setCwd(draft.cwd)
    setProjectId(draft.projectId)
    textRef.current?.focus()
  }, [draft])

  // Defaults once settings arrive.
  useEffect(() => {
    if (!settings) return
    setCwd((c) => c ?? settings.pinnedFolders[0] ?? settings.recentFolders[0])
    setPermissionMode((p) => p ?? settings.defaultPermissionMode)
  }, [settings])

  useEffect(() => {
    const focus = () => textRef.current?.focus()
    window.addEventListener(FOCUS_NEW_SESSION_EVENT, focus)
    return () => window.removeEventListener(FOCUS_NEW_SESSION_EVENT, focus)
  }, [])

  // Worktree option only makes sense inside a git repo.
  useEffect(() => {
    setIsRepo(false)
    if (!cwd) return
    let alive = true
    bridge
      .invoke(GIT.isRepo, cwd)
      .then((v) => alive && setIsRepo(!!v))
      .catch(() => alive && setIsRepo(false))
    return () => {
      alive = false
    }
  }, [cwd])

  const pinned = settings?.pinnedFolders ?? []
  const recent = (settings?.recentFolders ?? []).filter((f) => !pinned.some((p) => samePath(p, f)))
  const isPinned = !!cwd && pinned.some((p) => samePath(p, cwd))
  const project = projects.find((p) => p.id === projectId)

  const togglePin = async (folder: string) => {
    if (!settings) return
    const has = settings.pinnedFolders.some((p) => samePath(p, folder))
    const pinnedFolders = has
      ? settings.pinnedFolders.filter((p) => !samePath(p, folder))
      : [folder, ...settings.pinnedFolders]
    await api
      .patchSettings({ pinnedFolders })
      .catch((err) => showToast(`Falha ao fixar pasta: ${errorText(err)}`, 'error'))
  }

  const chooseFolder = async () => {
    const folder = await api.pickFolder(cwd)
    if (!folder) return
    setCwd(folder)
    if (project && !samePath(project.cwd, folder)) setProjectId(undefined)
  }

  const folderItems = (): MenuItem[] => {
    const entry = (f: string): MenuItem => ({
      label: f,
      checked: !!cwd && samePath(cwd, f),
      onSelect: () => {
        setCwd(f)
        if (project && !samePath(project.cwd, f)) setProjectId(undefined)
      }
    })
    const items: MenuItem[] = []
    if (pinned.length) items.push({ label: 'Fixadas', disabled: true }, ...pinned.map(entry))
    if (recent.length) {
      if (items.length) items.push({ separator: true })
      items.push({ label: 'Recentes', disabled: true }, ...recent.map(entry))
    }
    if (items.length) items.push({ separator: true })
    items.push({ label: 'Escolher pasta…', onSelect: () => void chooseFolder() })
    return items
  }

  const submit = async () => {
    const text = prompt.trim()
    if (busy || !canCreate) return
    if (!cwd) {
      setError('Escolha uma pasta para a sessão.')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      let worktree: Worktree | undefined
      if (useWorktree && isRepo) worktree = await bridge.invoke(GIT.worktreeCreate, cwd)
      const input: CreateSessionInput = {
        id: nanoid(),
        cwd,
        title: title.trim() || undefined,
        projectId,
        model: choice?.model,
        permissionMode,
        worktree
      }
      const session = await bridge.invoke(SESSIONS.create, input)
      // Another profile than the default (e.g. a synced token model): the session runs on it from the first turn.
      if (choice && choice.providerId !== settings?.defaultProviderId) await platformApi.chooseModel(session.id, choice)
      setPrompt('')
      setTitle('')
      useUi.getState().selectSession(session.id)
      if (!text) return
      bridge.invoke(ENGINE.send, session.id, text).catch((err) => {
        console.error('[sessions] engine:send failed', err)
        useSessionsUi.getState().showToast(`Não foi possível enviar o prompt: ${errorText(err)}`, 'error')
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.newView}>
      <div className={styles.newInner}>
        <h1 className={styles.greeting}>
          {greeting()}! <span>Em que vamos trabalhar?</span>
        </h1>

        <div className={styles.newBar}>
          <button
            className={`btn ${styles.folderBtn}`}
            title={cwd ?? 'Escolher pasta'}
            onClick={(e) => {
              if (!pinned.length && !recent.length) void chooseFolder()
              else setFolderMenu(anchorBelow(e.currentTarget))
            }}
          >
            <FolderIcon />
            <span className={styles.folderName}>{cwd ? shortFolder(cwd) : 'Escolher pasta'}</span>
            <span className={styles.caret}>▾</span>
          </button>
          {cwd && (
            <button
              className={`icon-btn ${isPinned ? styles.pinOn : ''}`}
              title={isPinned ? 'Desafixar pasta' : 'Fixar pasta'}
              onClick={() => void togglePin(cwd)}
            >
              <PinIcon filled={isPinned} />
            </button>
          )}

          <select
            className={`input ${styles.select}`}
            value={projectId ?? ''}
            title="Projeto"
            onChange={(e) => {
              const id = e.target.value || undefined
              setProjectId(id)
              const p = projects.find((x) => x.id === id)
              if (p) setCwd(p.cwd)
            }}
          >
            <option value="">Sem projeto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {isRepo && (
            <label className={styles.toggle} title="Cria um branch e uma pasta separados para esta sessão">
              <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
              <BranchIcon />
              Worktree isolado
            </label>
          )}
        </div>
        {cwd && <div className={styles.fullPath}>{cwd}</div>}

        <PlatformRequiredNotice />
        <div className={styles.composer}>
          <input
            className={styles.composerTitle}
            placeholder="Nome da sessão (opcional)"
            aria-label="Nome da sessão"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (prompt.trim()) void submit()
                else textRef.current?.focus()
              }
            }}
          />
          <textarea
            ref={textRef}
            className={styles.composerText}
            autoFocus
            rows={4}
            placeholder={
              project
                ? `Descreva a tarefa para ${project.name}…`
                : 'Descreva a tarefa… (Enter envia, Shift+Enter quebra linha).'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className={styles.composerBar}>
            {settings && (
              <ModelPicker
                className={`input ${styles.selectSmall}`}
                value={choice ?? { providerId: settings.defaultProviderId, model: settings.defaultModel }}
                onChange={setChoice}
              />
            )}
            <select
              className={`input ${styles.selectSmall}`}
              value={permissionMode ?? 'default'}
              title="Modo de permissão"
              onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
            >
              {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_LABELS[m]}
                </option>
              ))}
            </select>
            <div className={styles.spacer} />
            <button
              className="btn btn-primary"
              disabled={!cwd || busy || !canCreate}
              title={prompt.trim() ? 'Cria a sessão e envia a mensagem' : 'Cria a sessão sem enviar mensagem'}
              onClick={() => void submit()}
            >
              {busy ? (useWorktree ? 'Criando worktree…' : 'Iniciando…') : prompt.trim() ? 'Iniciar' : 'Criar sessão'}
            </button>
          </div>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        {project?.instructions && (
          <div className={styles.projectHint}>
            <b>{project.name}</b>: as instruções do projeto serão anexadas ao prompt de sistema.
          </div>
        )}
      </div>
      {folderMenu && <ContextMenu items={folderItems()} at={folderMenu} onClose={() => setFolderMenu(undefined)} />}
      <SessionsOverlay />
    </div>
  )
}
