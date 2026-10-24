// Feature-local UI state (not persisted): inline rename, open dialog, toast, new-session draft.
import { create } from 'zustand'
import type { Group, Project, Session } from '@shared/contracts'

export type SessionsDialog =
  | { kind: 'delete'; session: Session }
  | { kind: 'newGroup'; moveSessionId?: string }
  | { kind: 'renameGroup'; group: Group }
  | { kind: 'deleteGroup'; group: Group }
  | { kind: 'project'; project?: Project }
  | { kind: 'deleteProject'; project: Project }
  | { kind: 'import' }

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error'
}

/** Preset applied by NewSessionView on mount (e.g. "Nova sessão neste projeto"). */
export interface NewSessionDraft {
  cwd?: string
  projectId?: string
  /** Bumped on every request so the view re-applies the preset even when values repeat. */
  nonce: number
}

interface SessionsUiState {
  renaming?: { id: string; where: 'sidebar' | 'header' }
  dialog?: SessionsDialog
  toasts: Toast[]
  draft: NewSessionDraft
  startRename(id: string, where: 'sidebar' | 'header'): void
  stopRename(): void
  openDialog(dialog: SessionsDialog): void
  closeDialog(): void
  showToast(text: string, tone?: Toast['tone']): void
  dismissToast(id: number): void
  setDraft(draft: Omit<NewSessionDraft, 'nonce'>): void
}

let toastSeq = 0

export const useSessionsUi = create<SessionsUiState>((set) => ({
  toasts: [],
  draft: { nonce: 0 },
  startRename: (id, where) => set({ renaming: { id, where } }),
  stopRename: () => set({ renaming: undefined }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: undefined }),
  showToast: (text, tone = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 7000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDraft: (draft) => set((s) => ({ draft: { ...draft, nonce: s.draft.nonce + 1 } }))
}))
