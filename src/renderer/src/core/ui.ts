// Global UI state (not persisted). Feature agents may read it and call the actions;
// add new fields only through the chief.
import { create } from 'zustand'
import type { SidePanelTab } from '@shared/contracts'

interface UiState {
  activeSessionId?: string
  sidebarOpen: boolean
  sidePanelOpen: boolean
  sidePanelTab: SidePanelTab
  settingsOpen: boolean
  /** Section the settings view should show when it opens (consumed and cleared by SettingsView). */
  settingsSection?: string
  paletteOpen: boolean
  /** Full-screen Harness Lab (compare variants) for this project directory. */
  labCwd?: string
  /** Native screen of the Agent Hangar workspace shown in the center (features/workspace); cleared by selectSession. */
  workspaceView?: 'home' | 'agents'
  selectSession(id: string | undefined): void
  toggleSidebar(): void
  openSidePanel(tab?: SidePanelTab): void
  closeSidePanel(): void
  setSettingsOpen(open: boolean): void
  /** Opens settings on a given section id (e.g. 'providers'). */
  openSettings(section?: string): void
  setPaletteOpen(open: boolean): void
  openLab(cwd: string): void
  closeLab(): void
  /** Shows a workspace screen (Início / Meus agentes) in place of the session. */
  openWorkspace(view: 'home' | 'agents'): void
  closeWorkspace(): void
}

export const useUi = create<UiState>((set) => ({
  sidebarOpen: true,
  sidePanelOpen: false,
  sidePanelTab: 'terminal',
  settingsOpen: false,
  paletteOpen: false,
  selectSession: (id) => set({ activeSessionId: id, workspaceView: undefined }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  openSidePanel: (tab) => set((s) => ({ sidePanelOpen: true, sidePanelTab: tab ?? s.sidePanelTab })),
  closeSidePanel: () => set({ sidePanelOpen: false }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  openLab: (cwd) => set({ labCwd: cwd }),
  closeLab: () => set({ labCwd: undefined }),
  openWorkspace: (view) => set({ workspaceView: view, activeSessionId: undefined }),
  closeWorkspace: () => set({ workspaceView: undefined })
}))
