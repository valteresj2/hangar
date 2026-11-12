// Where the Hangar Harness lives and which Python runs it.
// The harness is pure Python (standard library only), shipped with the app under resources/harness. It needs a
// Python 3.11+ on the machine: the app does not bundle an interpreter.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { settings } from '../../../core/store'

export interface PythonLaunch {
  cmd: string
  args: string[]
  version: string
}

let cached: PythonLaunch | undefined
let cachedFor: string | undefined

const PROBE = 'import sys;print("%d.%d.%d" % sys.version_info[:3]);sys.exit(0 if sys.version_info >= (3, 11) else 3)'

function probe(cmd: string, args: string[]): PythonLaunch | undefined {
  try {
    const r = spawnSync(cmd, [...args, '-c', PROBE], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    if (r.status === 0 && r.stdout.trim()) return { cmd, args, version: r.stdout.trim() }
  } catch {
    // Not on PATH or not runnable: try the next candidate.
  }
  return undefined
}

/** A Python 3.11+ to run the harness with, or an Error whose message tells the user what to do. */
export function findPython(): PythonLaunch {
  const configured = settings().get().hangarPythonPath?.trim() || process.env.HANGAR_PYTHON?.trim() || ''
  if (cached && cachedFor === configured) return cached
  const candidates: [string, string[]][] = configured
    ? [[configured, []]]
    : process.platform === 'win32'
      ? [
          ['python', []],
          ['py', ['-3']],
          ['python3', []]
        ]
      : [
          ['python3', []],
          ['python', []]
        ]
  for (const [cmd, args] of candidates) {
    const found = probe(cmd, args)
    if (found) {
      cached = found
      cachedFor = configured
      return found
    }
  }
  throw new Error(
    configured
      ? `O Python configurado ("${configured}") não respondeu ou é anterior ao 3.11.`
      : 'O motor Hangar precisa do Python 3.11 ou mais novo, e nenhum foi encontrado no PATH. Instale em python.org (marque "Add python.exe to PATH") e reabra o app.'
  )
}

/** The folder that contains the `hangar` Python package. */
export function harnessDir(): string {
  const override = process.env.HANGAR_HARNESS_DIR?.trim()
  if (override && existsSync(join(override, 'hangar', 'bridge.py'))) return override
  // Dev: <repo>/resources/harness. Packaged: resources/** is unpacked next to app.asar (electron-builder.yml →
  // asarUnpack), and Python cannot read from inside the archive, so the unpacked copy comes first.
  const appPath = app.getAppPath()
  const candidates = [
    join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'harness'),
    join(appPath, 'resources', 'harness')
  ]
  for (const dir of candidates) if (existsSync(join(dir, 'hangar', 'bridge.py'))) return dir
  throw new Error('O motor Hangar não foi encontrado nos recursos do app (resources/harness).')
}

/** Version of the bundled harness (first line of resources/harness/VERSION, written by build/sync-harness.cjs). */
export function harnessVersion(): string | undefined {
  try {
    return readFileSync(join(harnessDir(), 'VERSION'), 'utf8').split('\n')[0].trim() || undefined
  } catch {
    return undefined
  }
}

/** Data folder of the harness (session logs, resumable transcripts): inside the app's own data, not ~/.hangar. */
export function harnessHome(): string {
  return join(app.getPath('userData'), 'hangar-data', 'harness')
}
