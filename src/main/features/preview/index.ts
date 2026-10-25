// Feature "preview" — main process side. Owned by the preview agent.
// Embedded browser hardening, dev servers from .claude/launch.json, and session artifacts.
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
import { handle } from '../../core/handle'

function onFileWritten(payload: { sessionId?: string; path?: string }): void {
  if (payload?.sessionId && payload.path) registerArtifact(payload.sessionId, payload.path)
}

// A deleted session forgets its artifacts and stops its dev servers; an archived one only stops the servers.
function onStoreChanged(change: StoreChange): void {
  if (change.collection !== 'sessions' || !change.id) return
  const session = db('sessions').get(change.id)
  if (session && !session.archived) return
  if (!session) pruneSession(change.id)
  stopSessionServers(change.id)
}

export const previewFeature: Feature = {
  name: 'preview',
  async register(ctx) {
    setupBrowser()
    loadArtifacts()

    // Dev servers
    handle(PREVIEW.launchConfigs, (_e, sessionId: string) => readLaunchConfigs(sessionId))
    handle(PREVIEW.launchSave, (_e, sessionId: string, text: string, overwrite?: boolean) =>
      saveLaunchConfigs(sessionId, text, !!overwrite)
    )
    handle(PREVIEW.start, (_e, sessionId: string, name: string) => startServer(sessionId, name))
    handle(PREVIEW.stop, (_e, serverId: string) => stopServer(serverId))
    handle(PREVIEW.servers, (_e, sessionId?: string) => listServers(sessionId))
    handle(PREVIEW.logs, (_e, serverId: string) => serverLogs(serverId))

    // Artifacts
    handle(PREVIEW.artifacts, (_e, sessionId: string) => listArtifacts(sessionId))
    handle(PREVIEW.artifactRead, (_e, pathOrId: string) => readArtifact(pathOrId))
    handle(PREVIEW.artifactAdd, (_e, sessionId: string, path?: string) =>
      addArtifactInteractive(ctx.mainWindow(), sessionId, path)
    )
    handle(PREVIEW.artifactRemove, (_e, id: string) => removeArtifact(id))
    handle(PREVIEW.artifactReveal, (_e, id: string) => revealArtifact(id))
    handle(PREVIEW.artifactOpen, (_e, id: string) => openArtifactExternally(id))
    handle(PREVIEW.artifactStat, (_e, id: string) => statArtifact(id))
    handle(PREVIEW.artifactWrite, (_e, id: string, text: string) => writeArtifact(id, text))

    // Hangar Motion
    handle(PREVIEW.motionAssets, (_e, id: string, srcs: string[]) => motionAssets(id, srcs))
    handle(PREVIEW.exportDialog, (_e, sessionId: string, title: string) =>
      exportDialog(ctx.mainWindow(), sessionId, title)
    )
    handle(PREVIEW.exportOpen, (_e, path: string) => exportOpen(path))
    handle(PREVIEW.exportWrite, (_e, id: string, position: number, data: Uint8Array) => exportWrite(id, position, data))
    handle(PREVIEW.exportClose, (_e, id: string, commit: boolean) => exportClose(id, !!commit))
    handle(PREVIEW.showInFolder, (_e, path: string) => showInFolder(path))

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
