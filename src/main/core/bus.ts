// In-process event bus for main-side communication between features.
// Known events (add yours here with a comment):
//   'store:changed'        { collection, id? }                 — core store
//   'session:status'       { sessionId, status }               — engine
//   'session:turn-ended'   { sessionId, result: 'success'|'error' } — engine
//   'session:needs-input'  { sessionId, reason }               — engine (permission / question)
//   'session:file-written' { sessionId, path }                 — engine (Write/Edit/MultiEdit/NotebookEdit ok)
// Listeners: engine (file-written; store:changed to clean up after deleted sessions), git and harness
// (turn-ended, file-written), lab (turn-ended, store:changed), preview (file-written, store:changed),
// settings (turn-ended, needs-input, store:changed), terminal (store:changed).

import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)
