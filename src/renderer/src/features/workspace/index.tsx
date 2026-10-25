// Feature "workspace" — renderer side. Owned by the workspace agent.
// WorkspaceNav: the "Agent Hangar" section of the sidebar (mounted by sessions/Sidebar.tsx). WorkspaceView: the
// Início / Meus agentes screen App.tsx shows in the center.
export { WorkspaceNav } from './WorkspaceNav'
export { WorkspaceView } from './WorkspaceView'
export { openPortal, useWorkspace, workspaceApi } from './api'
