// Feature "engine" — main process side. Owned by the engine agent.
// Drives Claude Code through the Agent SDK: one streaming query per session (see runner.ts).
import type { Feature } from '../../core/feature'
import { bus } from '../../core/bus'
import { db } from '../../core/store'
import type { StoreChange } from '../../../shared/contracts'
import {
  ENGINE,
  type EngineOptions,
  type PermissionResponse,
  type RewindOptions,
  type SendOptions
} from '../../../shared/features/engine'
import { interrupt, readTranscript, searchTranscripts, sendPrompt } from './api'
import { fork, rewind, rewindPreview } from './branch'
import { invalidateFiles, listFiles } from './files'
import { imageDataUrl } from './images'
import { setRewindPoint } from './points'
import { profiles } from './providers'
import {
  closeAll,
  closeRunner,
  existingRunner,
  runnerFor,
  setActive,
  slashCommandsFor,
  stateOf,
  switchProvider
} from './registry'
import { handle } from '../../core/handle'
import { startCompatProxy, stopCompatProxy } from './compat'

export const engineFeature: Feature = {
  name: 'engine',
  async register() {
    // Gateway launches go through the local compat proxy (engine/compat/); without it they go direct.
    await startCompatProxy().catch((err) => console.error('[hangar] compat proxy could not start', err))

    // Nothing survives a restart: sessions left mid-turn are idle now.
    for (const s of db('sessions').list()) {
      if (s.status === 'working' || s.status === 'waiting') db('sessions').patch(s.id, { status: 'idle' })
    }

    handle(ENGINE.send, (_e, sessionId: string, text: string, opts?: SendOptions) => sendPrompt(sessionId, text, opts))
    handle(ENGINE.interrupt, (_e, sessionId: string) => interrupt(sessionId))
    handle(ENGINE.history, (_e, sessionId: string) => readTranscript(sessionId))
    handle(ENGINE.search, (_e, query: string) => searchTranscripts(query))
    handle(ENGINE.respondPermission, (_e, sessionId: string, requestId: string, response: PermissionResponse) =>
      existingRunner(sessionId)?.respond(requestId, response)
    )
    handle(ENGINE.setActive, (_e, sessionId?: string) => setActive(sessionId))
    handle(ENGINE.setOptions, (_e, sessionId: string, patch: EngineOptions) => runnerFor(sessionId).setOptions(patch))
    handle(ENGINE.slashCommands, (_e, sessionId: string) => slashCommandsFor(sessionId))
    handle(ENGINE.state, (_e, sessionId: string) => stateOf(sessionId))
    handle(ENGINE.listFiles, (_e, sessionId: string, query: string) => listFiles(sessionId, query ?? ''))
    handle(ENGINE.readImage, (_e, path: string) => imageDataUrl(path))
    handle(ENGINE.rewindPreview, (_e, sessionId: string, entryId: string) => rewindPreview(sessionId, entryId))
    handle(ENGINE.rewind, (_e, sessionId: string, entryId: string, opts?: RewindOptions) =>
      rewind(sessionId, entryId, opts)
    )
    handle(ENGINE.fork, (_e, sessionId: string, entryId: string) => fork(sessionId, entryId))
    handle(ENGINE.providers, () => profiles())
    handle(ENGINE.setProvider, (_e, sessionId: string, providerId: string) => switchProvider(sessionId, providerId))

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
  async dispose() {
    closeAll()
    await stopCompatProxy()
  }
}
