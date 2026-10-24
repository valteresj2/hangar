// Queue for OPEN_ARTIFACT_EVENT. The sender opens the Artifacts tab and dispatches the event in the same tick,
// before the panel has mounted, so the request is kept here until a panel consumes it.
import { OPEN_ARTIFACT_EVENT, type OpenArtifactDetail } from '@shared/motion/spec'

let pending: string | undefined
const listeners = new Set<() => void>()

window.addEventListener(OPEN_ARTIFACT_EVENT, (event) => {
  const path = (event as CustomEvent<OpenArtifactDetail>).detail?.path
  if (typeof path !== 'string' || !path) return
  pending = path
  for (const fn of listeners) fn()
})

/** Returns and clears the pending path, if any. */
export function takeOpenRequest(): string | undefined {
  const path = pending
  pending = undefined
  return path
}

/** Calls `fn` whenever a new open request arrives. Returns the unsubscribe function. */
export function onOpenRequest(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
