// Feature "preview" — main process side. Owned by the preview agent.
// Embedded browser hardening, dev servers from .claude/launch.json, and session artifacts.
import { ipcMain } from 'electron'
import { bus } from '../../core/bus'
import type { Feature } from '../../core/feature'
import { db } from '../../core/store'
import type { StoreChange } from '../../../shared/contracts'
import { PREVIEW } from '../../../shared/features/preview'
import {
  addArtifactInteractive,
  findArtifact,
  flushArtifacts,
  listArtifacts,
  loadArtifacts,
  motionAssets,
  openArtifactExternally,
  pruneSession,
  readArtifact,
  registerArtifact,
  removeArtifact,
  revealArtifact,
  statArtifact,
  writeArtifact
} from './artifacts'
import { startArtifactServer, stopArtifactServer } from './artifactServer'
import { disposeBrowser, setupBrowser } from './browser'
import { disposeExports, exportClose, exportDialog, exportOpen, exportWrite, showInFolder } from './export'
import {
  disposeServers,
  listServers,
  readLaunchConfigs,
  saveLaunchConfigs,
  serverLogs,
  startServer,
  stopServer,
  stopSessionServers
} from './servers'

function onFileWritten(payload: { sessionId?: string; path?: string }): void {
  if (payload?.sessionId && payload.path) registerArtifact(payload.sessionId, payload.path)
}

// When a session is deleted, forget its artifacts and stop its dev servers.
function onStoreChanged(change: StoreChange): void {
  if (change.collection !== 'sessions' || !change.id || db('sessions').get(change.id)) return
  pruneSession(change.id)
  stopSessionServers(change.id)
}

export const previewFeature: Feature = {
  name: 'preview',
  async register(ctx) {
    setupBrowser()
    loadArtifacts()

    // Dev servers
    ipcMain.handle(PREVIEW.launchConfigs, (_e, sessionId: string) => readLaunchConfigs(sessionId))
    ipcMain.handle(PREVIEW.launchSave, (_e, sessionId: string, text: string, overwrite?: boolean) =>
      saveLaunchConfigs(sessionId, text, !!overwrite)
    )
    ipcMain.handle(PREVIEW.start, (_e, sessionId: string, name: string) => startServer(sessionId, name))
    ipcMain.handle(PREVIEW.stop, (_e, serverId: string) => stopServer(serverId))
    ipcMain.handle(PREVIEW.servers, (_e, sessionId?: string) => listServers(sessionId))
    ipcMain.handle(PREVIEW.logs, (_e, serverId: string) => serverLogs(serverId))

    // Artifacts
    ipcMain.handle(PREVIEW.artifacts, (_e, sessionId: string) => listArtifacts(sessionId))
    ipcMain.handle(PREVIEW.artifactRead, (_e, pathOrId: string) => readArtifact(pathOrId))
    ipcMain.handle(PREVIEW.artifactAdd, (_e, sessionId: string, path?: string) =>
      addArtifactInteractive(ctx.mainWindow(), sessionId, path)
    )
    ipcMain.handle(PREVIEW.artifactRemove, (_e, id: string) => removeArtifact(id))
    ipcMain.handle(PREVIEW.artifactReveal, (_e, id: string) => revealArtifact(id))
    ipcMain.handle(PREVIEW.artifactOpen, (_e, id: string) => openArtifactExternally(id))
    ipcMain.handle(PREVIEW.artifactStat, (_e, id: string) => statArtifact(id))
    ipcMain.handle(PREVIEW.artifactWrite, (_e, id: string, text: string) => writeArtifact(id, text))

    // Hangar Motion
    ipcMain.handle(PREVIEW.motionAssets, (_e, id: string, srcs: string[]) => motionAssets(id, srcs))
    ipcMain.handle(PREVIEW.exportDialog, (_e, sessionId: string, title: string) => exportDialog(ctx.mainWindow(), sessionId, title))
    ipcMain.handle(PREVIEW.exportOpen, (_e, path: string) => exportOpen(path))
    ipcMain.handle(PREVIEW.exportWrite, (_e, id: string, position: number, data: Uint8Array) => exportWrite(id, position, data))
    ipcMain.handle(PREVIEW.exportClose, (_e, id: string, commit: boolean) => exportClose(id, !!commit))
    ipcMain.handle(PREVIEW.showInFolder, (_e, path: string) => showInFolder(path))

    bus.on('session:file-written', onFileWritten)
    bus.on('store:changed', onStoreChanged)

    try {
      await startArtifactServer(findArtifact)
    } catch (err) {
      console.error('[preview] artifact server failed to start; HTML artifacts fall back to srcdoc', err)
    }
  },
  dispose() {
    disposeServers()
    void disposeExports()
    stopArtifactServer()
    disposeBrowser()
    bus.removeListener('session:file-written', onFileWritten)
    bus.removeListener('store:changed', onStoreChanged)
    flushArtifacts()
  }
}
