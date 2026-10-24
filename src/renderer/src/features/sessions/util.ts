import type { PermissionMode, Session } from '@shared/contracts'

export function sessionDir(session: Session): string {
  return session.worktree?.path ?? session.cwd
}

/** Last path segment, for compact display ("C:\a\b\hangar" → "hangar"). */
export function shortFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'agora'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d`
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export const byUpdatedDesc = (a: Session, b: Session) => b.updatedAt - a.updatedAt

export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke prefixes remote errors with "Error invoking remote method '<channel>': Error: ".
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

export const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku', 'fable']

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Perguntar',
  acceptEdits: 'Aceitar edições',
  plan: 'Planejar',
  auto: 'Auto',
  bypassPermissions: 'Ignorar permissões'
}
