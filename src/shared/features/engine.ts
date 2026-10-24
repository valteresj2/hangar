// IPC channels and payload types for the "engine" feature. Owned by the engine agent.
export const ENGINE = {
  send: 'engine:send',
  interrupt: 'engine:interrupt',
  history: 'engine:history',
  search: 'engine:search'
} as const

/** One persisted transcript line. The engine agent refines this union. */
export type TranscriptEntry = {
  id: string
  ts: number
  kind: string
  [key: string]: unknown
}
