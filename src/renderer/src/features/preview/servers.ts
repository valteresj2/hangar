// Renderer hooks over the dev-server IPC.
import { useCallback, useEffect, useState } from 'react'
import { PREVIEW, type LaunchConfigsResult, type ServerEvent, type ServerInfo } from '@shared/features/preview'
import { bridge } from '../../core/api'
import { stripAnsi } from './webview'

export const previewApi = {
  launchConfigs: (sessionId: string) => bridge.invoke(PREVIEW.launchConfigs, sessionId),
  start: (sessionId: string, name: string) => bridge.invoke(PREVIEW.start, sessionId, name),
  stop: (serverId: string) => bridge.invoke(PREVIEW.stop, serverId),
  servers: (sessionId: string) => bridge.invoke(PREVIEW.servers, sessionId),
  logs: (serverId: string) => bridge.invoke(PREVIEW.logs, serverId)
}

/** Servers of a session, refreshed on every state change. */
export function useServers(sessionId: string): ServerInfo[] {
  const [servers, setServers] = useState<ServerInfo[]>([])
  useEffect(() => {
    let alive = true
    const load = () => void previewApi.servers(sessionId).then((s) => alive && setServers(s))
    load()
    const off = bridge.on(PREVIEW.serverEvent, (e: ServerEvent) => {
      if (e.type === 'state' && e.server.sessionId === sessionId) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return servers
}

export function useLaunchConfigs(sessionId: string): { data?: LaunchConfigsResult; reload(): void } {
  const [data, setData] = useState<LaunchConfigsResult>()
  const reload = useCallback(() => {
    previewApi
      .launchConfigs(sessionId)
      .then(setData, (err: Error) => setData({ path: '', exists: false, configurations: [], error: err.message }))
  }, [sessionId])
  useEffect(reload, [reload])
  return { data, reload }
}

const MAX_VISIBLE_LOG = 200_000

/** Live log text (ANSI stripped) of one server. */
export function useServerLog(serverId: string | undefined): string {
  const [log, setLog] = useState('')
  useEffect(() => {
    setLog('')
    if (!serverId) return
    let alive = true
    let loaded = false
    // Main flushes pending log events before answering, so the snapshot already holds
    // everything that arrived earlier; only chunks after it are appended.
    void previewApi.logs(serverId).then((text) => {
      if (!alive) return
      loaded = true
      setLog(stripAnsi(text).slice(-MAX_VISIBLE_LOG))
    })
    const off = bridge.on(PREVIEW.serverEvent, (e: ServerEvent) => {
      if (e.type !== 'log' || e.serverId !== serverId || !loaded) return
      setLog((cur) => (cur + stripAnsi(e.chunk)).slice(-MAX_VISIBLE_LOG))
    })
    return () => {
      alive = false
      off()
    }
  }, [serverId])
  return log
}
