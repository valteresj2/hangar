// Feature "engine" — main process side. Owned by the engine agent.
// Drives Claude Code through the Agent SDK: one streaming query per session (see runner.ts).
import { ipcMain } from 'electron'
import type { Feature } from '../../core/feature'
import { bus } from '../../core/bus'
import { db } from '../../core/store'
import type { StoreChange } from '../../../shared/contracts'
import { ENGINE, type EngineOptions, type PermissionResponse, type RewindOptions, type SendOptions } from '../../../shared/features/engine'
import { interrupt, readTranscript, searchTranscripts, sendPrompt } from './api'
import { fork, rewind, rewindPreview } from './branch'
import { invalidateFiles, listFiles } from './files'
import { imageDataUrl } from './images'
import { setRewindPoint } from './points'
import { profiles } from './providers'
import { closeAll, closeRunner, existingRunner, runnerFor, setActive, slashCommandsFor, stateOf, switchProvider } from './registry'

export const engineFeature: Feature = {
  name: 'engine',
  register() {
    // Nothing survives a restart: sessions left mid-turn are idle now.
    for (const s of db('sessions').list()) {
      if (s.status === 'working' || s.status === 'waiting') db('sessions').patch(s.id, { status: 'idle' })
    }

    ipcMain.handle(ENGINE.send, (_e, sessionId: string, text: string, opts?: SendOptions) => sendPrompt(sessionId, text, opts))
    ipcMain.handle(ENGINE.interrupt, (_e, sessionId: string) => interrupt(sessionId))
    ipcMain.handle(ENGINE.history, (_e, sessionId: string) => readTranscript(sessionId))
    ipcMain.handle(ENGINE.search, (_e, query: string) => searchTranscripts(query))
    ipcMain.handle(ENGINE.respondPermission, (_e, sessionId: string, requestId: string, response: PermissionResponse) =>
      existingRunner(sessionId)?.respond(requestId, response)
    )
    ipcMain.handle(ENGINE.setActive, (_e, sessionId?: string) => setActive(sessionId))
    ipcMain.handle(ENGINE.setOptions, (_e, sessionId: string, patch: EngineOptions) => runnerFor(sessionId).setOptions(patch))
    ipcMain.handle(ENGINE.slashCommands, (_e, sessionId: string) => slashCommandsFor(sessionId))
    ipcMain.handle(ENGINE.state, (_e, sessionId: string) => stateOf(sessionId))
    ipcMain.handle(ENGINE.listFiles, (_e, sessionId: string, query: string) => listFiles(sessionId, query ?? ''))
    ipcMain.handle(ENGINE.readImage, (_e, path: string) => imageDataUrl(path))
    ipcMain.handle(ENGINE.rewindPreview, (_e, sessionId: string, entryId: string) => rewindPreview(sessionId, entryId))
    ipcMain.handle(ENGINE.rewind, (_e, sessionId: string, entryId: string, opts?: RewindOptions) => rewind(sessionId, entryId, opts))
    ipcMain.handle(ENGINE.fork, (_e, sessionId: string, entryId: string) => fork(sessionId, entryId))
    ipcMain.handle(ENGINE.providers, () => profiles())
    ipcMain.handle(ENGINE.setProvider, (_e, sessionId: string, providerId: string) => switchProvider(sessionId, providerId))

    // Files the agent writes show up in the @mention index right away.
    bus.on('session:file-written', ({ sessionId }: { sessionId: string }) => invalidateFiles(sessionId))

    // A deleted session takes its Claude Code process with it; an archived one releases it (resumable later).
    bus.on('store:changed', (change: StoreChange) => {
      if (change.collection !== 'sessions' || !change.id) return
      const session = db('sessions').get(change.id)
      if (session?.archived) return closeRunner(change.id)
      if (session) return
      closeRunner(change.id)
      invalidateFiles(change.id)
      setRewindPoint(change.id, undefined)
    })
  },
  dispose() {
    closeAll()
  }
}
