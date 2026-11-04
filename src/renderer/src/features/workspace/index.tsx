// Feature "workspace" — renderer side. Owned by the workspace agent.
// WorkspaceNav: the "Agent Hangar" section of the sidebar (mounted by sessions/Sidebar.tsx). WorkspaceView: the
// Início / Meus agentes screen App.tsx shows in the center. TaskFollowPanel: the platform tasks a session follows
// (mounted by engine/ChatView.tsx above the composer).
export { WorkspaceNav } from './WorkspaceNav'
export { WorkspaceView } from './WorkspaceView'
export { TaskFollowPanel } from './TaskFollowPanel'
export { openPortal, useWorkspace, workspaceApi } from './api'
