// In-process event bus for main-side communication between features.
// Known events (add yours here with a comment):
//   'store:changed'        { collection, id? }                 — core store
//   'session:status'       { sessionId, status }               — engine
//   'session:turn-ended'   { sessionId, result: 'success'|'error' } — engine
//   'session:needs-input'  { sessionId, reason }               — engine (permission / question)

import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)
