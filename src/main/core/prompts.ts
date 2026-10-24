// Registry of system-prompt appendices contributed by features (e.g. the harness feature's
// project lessons). The engine appends every non-empty contribution when it starts a session runner.

import type { Session } from '../../shared/contracts'

export type SystemAppendProvider = (session: Session) => string | undefined

const providers = new Map<string, SystemAppendProvider>()

/** Registers (or replaces) a named provider. Call from a feature's register(). */
export function registerSystemAppend(name: string, provider: SystemAppendProvider): void {
  providers.set(name, provider)
}

/** Every provider's text for this session, in registration order; failing providers are skipped. */
export function collectSystemAppend(session: Session): string[] {
  const out: string[] = []
  for (const [name, provider] of providers) {
    try {
      const text = provider(session)?.trim()
      if (text) out.push(text)
    } catch (err) {
      console.error(`[hangar] system append provider "${name}" failed`, err)
    }
  }
  return out
}
