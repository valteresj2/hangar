// Session/group/project actions shared by the sidebar, the context menu and the session header.
import { nanoid } from 'nanoid'
import type { Group, Project, Session } from '@shared/contracts'
import { DEFAULT_SESSION_TITLE, SESSIONS, type ImportCliResult, type CliSessionInfo } from '@shared/features/sessions'
import { api, bridge } from '../../core/api'
import { useUi } from '../../core/ui'
import type { MenuItem } from './ContextMenu'
import { useSessionsUi } from './store'
import { errorText, sessionDir } from './util'

const toast = (text: string, tone?: 'info' | 'error') => useSessionsUi.getState().showToast(text, tone)

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[sessions] ${what}`, err)
    toast(`${what}: ${errorText(err)}`, 'error')
    return undefined
  }
}

export function openSession(session: Session): void {
  useUi.getState().selectSession(session.id)
  if (session.unread) void api.patch('sessions', session.id, { unread: false })
}

export function renameSession(id: string, title: string): Promise<unknown> {
  return guard('Não foi possível renomear', () =>
    api.patch('sessions', id, { title: title.trim() || DEFAULT_SESSION_TITLE })
  )
}

export function setPinned(session: Session, pinned: boolean): Promise<unknown> {
  return guard('Não foi possível fixar', () => api.patch('sessions', session.id, { pinned }))
}

export function setArchived(session: Session, archived: boolean): Promise<unknown> {
  return guard('Não foi possível arquivar', () => api.patch('sessions', session.id, { archived }))
}

export function moveToGroup(sessionId: string, groupId: string | undefined): Promise<unknown> {
  return guard('Não foi possível mover', () => api.patch('sessions', sessionId, { groupId }))
}

export async function exportSession(session: Session): Promise<void> {
  const path = await guard('Falha ao exportar', () => bridge.invoke(SESSIONS.exportMarkdown, session.id))
  if (path) toast(`Exportado para ${path}`)
}

export function openFolder(session: Session): void {
  void guard('Não foi possível abrir a pasta', () => api.openPath(sessionDir(session)))
}

export async function deleteSession(session: Session, removeWorktree: boolean): Promise<void> {
  const res = await guard('Falha ao excluir', () => bridge.invoke(SESSIONS.delete, session.id, { removeWorktree }))
  if (!res?.deleted) return
  const ui = useUi.getState()
  if (ui.activeSessionId === session.id) ui.selectSession(undefined)
  if (res.worktreeError) toast(`Sessão excluída, mas o worktree não foi removido: ${res.worktreeError}`, 'error')
}

export async function createGroup(name: string, groups: Group[]): Promise<Group | undefined> {
  const group: Group = {
    id: nanoid(),
    name: name.trim() || 'Novo grupo',
    order: Math.max(-1, ...groups.map((g) => g.order)) + 1
  }
  return guard('Não foi possível criar o grupo', () => api.put('groups', group))
}

export function renameGroup(group: Group, name: string): Promise<unknown> {
  return guard('Não foi possível renomear o grupo', () =>
    api.patch('groups', group.id, { name: name.trim() || group.name })
  )
}

export function setGroupCollapsed(group: Group, collapsed: boolean): Promise<unknown> {
  return guard('Falha ao atualizar o grupo', () => api.patch('groups', group.id, { collapsed }))
}

/** Deletes a group; its sessions go back to "Recentes". */
export async function deleteGroup(group: Group, sessions: Session[]): Promise<void> {
  await guard('Não foi possível excluir o grupo', async () => {
    for (const s of sessions.filter((s) => s.groupId === group.id))
      await api.patch('sessions', s.id, { groupId: undefined })
    await api.remove('groups', group.id)
  })
}

/** Moves `groupId` to position `index` in the ordered list and renumbers every group. */
export async function reorderGroup(groups: Group[], groupId: string, index: number): Promise<void> {
  const ordered = [...groups].sort((a, b) => a.order - b.order)
  const from = ordered.findIndex((g) => g.id === groupId)
  if (from < 0) return
  const [moved] = ordered.splice(from, 1)
  ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, moved)
  await guard('Não foi possível reordenar', async () => {
    for (const [i, g] of ordered.entries()) if (g.order !== i) await api.patch('groups', g.id, { order: i })
  })
}

export async function saveProject(
  input: Omit<Project, 'id' | 'createdAt'>,
  existing?: Project
): Promise<Project | undefined> {
  const project: Project = existing ? { ...existing, ...input } : { ...input, id: nanoid(), createdAt: Date.now() }
  return guard('Não foi possível salvar o projeto', () => api.put('projects', project))
}

/** Deletes a project; its sessions are kept and simply lose the link. */
export async function deleteProject(project: Project, sessions: Session[]): Promise<void> {
  await guard('Não foi possível excluir o projeto', async () => {
    for (const s of sessions.filter((s) => s.projectId === project.id))
      await api.patch('sessions', s.id, { projectId: undefined })
    await api.remove('projects', project.id)
  })
}

export function listCliSessions(): Promise<CliSessionInfo[]> {
  return bridge.invoke(SESSIONS.listCli)
}

export async function importCliSessions(ids: string[]): Promise<ImportCliResult | undefined> {
  const res = await guard('Falha ao importar', () => bridge.invoke(SESSIONS.importCli, ids))
  if (res) {
    const extra = res.skipped ? ` (${res.skipped} já importada${res.skipped > 1 ? 's' : ''})` : ''
    toast(`${res.imported} sess${res.imported === 1 ? 'ão importada' : 'ões importadas'}${extra}`)
  }
  return res
}

/** Context-menu / "…" menu entries for a session. */
export function sessionMenu(session: Session, groups: Group[], where: 'sidebar' | 'header'): MenuItem[] {
  const { startRename, openDialog } = useSessionsUi.getState()
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order)
  return [
    { label: 'Renomear', onSelect: () => startRename(session.id, where) },
    { label: session.pinned ? 'Desafixar' : 'Fixar', onSelect: () => void setPinned(session, !session.pinned) },
    {
      label: 'Mover para grupo',
      submenu: [
        ...sortedGroups.map((g) => ({
          label: g.name,
          checked: session.groupId === g.id,
          onSelect: () => void moveToGroup(session.id, g.id)
        })),
        ...(sortedGroups.length ? [{ separator: true } as MenuItem] : []),
        { label: 'Novo grupo…', onSelect: () => openDialog({ kind: 'newGroup', moveSessionId: session.id }) },
        ...(session.groupId
          ? [{ label: 'Remover do grupo', onSelect: () => void moveToGroup(session.id, undefined) }]
          : [])
      ]
    },
    {
      label: session.archived ? 'Desarquivar' : 'Arquivar',
      onSelect: () => void setArchived(session, !session.archived)
    },
    { separator: true },
    { label: 'Exportar como Markdown…', onSelect: () => void exportSession(session) },
    { label: 'Abrir pasta', onSelect: () => openFolder(session) },
    { separator: true },
    { label: 'Excluir…', danger: true, onSelect: () => openDialog({ kind: 'delete', session }) }
  ]
}
