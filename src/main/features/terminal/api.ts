// Main-side API of the terminal feature, used by other features. Owned by the terminal agent.
import { createTerminal, writeTerminal } from './manager'

/**
 * Opens a new terminal tab (default shell) for the session and types `command` into it.
 * The renderer adopts the tab through `terminal:event:created`. Resolves with the terminal id.
 */
export async function runInNewTerminal(sessionId: string, cwd: string, command: string): Promise<string> {
  const info = await createTerminal({ sessionId, cwd, cols: 100, rows: 30 })
  // The PTY buffers input until the shell starts reading, so typing ahead is safe.
  if (command) writeTerminal(info.id, `${command}\r`)
  return info.id
}
