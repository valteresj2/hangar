// Live chat state for one session: persisted history plus engine events (entries, deltas, permissions, status).
import { useEffect, useState } from 'react'
import {
  ENGINE,
  type DeltaEvent,
  type EngineState,
  type EntryEvent,
  type PermissionEvent,
  type PermissionRequest,
  type StatusEvent,
  type TranscriptEntry
} from '@shared/features/engine'
import { bridge } from '../../core/api'

export interface ChatState {
  loaded: boolean
  entries: TranscriptEntry[]
  streamText: string
  streamThinking: string
  pending: PermissionRequest[]
  busy: boolean
}

const EMPTY: ChatState = { loaded: false, entries: [], streamText: '', streamThinking: '', pending: [], busy: false }

export function useChat(sessionId: string): ChatState {
  const [state, setState] = useState<ChatState>(EMPTY)

  useEffect(() => {
    let alive = true
    let loaded = false
    // Events that arrive while history is loading are replayed on top of it.
    const early: TranscriptEntry[] = []
    setState(EMPTY)

    const onEntry = ({ sessionId: id, entry }: EntryEvent) => {
      if (id !== sessionId) return
      if (!loaded) return void early.push(entry)
      setState((s) => {
        const next = { ...s, entries: [...s.entries, entry] }
        if (entry.kind === 'assistant') next.streamText = ''
        if (entry.kind === 'thinking') next.streamThinking = ''
        if (entry.kind === 'result') Object.assign(next, { streamText: '', streamThinking: '' })
        return next
      })
    }
    const onDelta = ({ sessionId: id, kind, text }: DeltaEvent) => {
      if (id !== sessionId || !loaded) return
      setState((s) => (kind === 'text' ? { ...s, streamText: s.streamText + text } : { ...s, streamThinking: s.streamThinking + text }))
    }
    const onPermission = (ev: PermissionEvent) => {
      if (ev.sessionId !== sessionId) return
      setState((s) =>
        ev.type === 'request'
          ? { ...s, pending: [...s.pending.filter((p) => p.requestId !== ev.request.requestId), ev.request] }
          : { ...s, pending: s.pending.filter((p) => p.requestId !== ev.requestId) }
      )
    }
    const onStatus = ({ sessionId: id, busy }: StatusEvent) => {
      if (id === sessionId) setState((s) => ({ ...s, busy }))
    }

    const offs = [
      bridge.on(ENGINE.evEntry, onEntry),
      bridge.on(ENGINE.evDelta, onDelta),
      bridge.on(ENGINE.evPermission, onPermission),
      bridge.on(ENGINE.evStatus, onStatus)
    ]

    void Promise.all([
      bridge.invoke<TranscriptEntry[]>(ENGINE.history, sessionId),
      bridge.invoke<EngineState>(ENGINE.state, sessionId)
    ]).then(([history, live]) => {
      if (!alive) return
      loaded = true
      const seen = new Set(history.map((e) => e.id))
      setState({
        loaded: true,
        entries: [...history, ...early.filter((e) => !seen.has(e.id))],
        streamText: live.streamText,
        streamThinking: live.streamThinking,
        pending: live.pending,
        busy: live.busy
      })
    })

    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [sessionId])

  return state
}
