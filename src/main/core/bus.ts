// In-process event bus for main-side communication between features.
// Known events (add yours here with a comment):
//   'store:changed'        { collection, id? }                 — core store
//   'session:status'       { sessionId, status }               — engine
//   'session:turn-ended'   { sessionId, result: 'success'|'error' } — engine
//   'session:needs-input'  { sessionId, reason }               — engine (permission / question)
//   'session:file-written' { sessionId, path }                 — engine (Write/Edit/MultiEdit/NotebookEdit ok)
// Listeners: git (turn-ended, file-written), preview (file-written), settings (turn-ended, needs-input),
// terminal and engine (store:changed, to clean up after deleted sessions).

import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)
