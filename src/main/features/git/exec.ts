// Thin wrapper around the git CLI: no shell, array arguments, bounded output and time.
import { execFile } from 'node:child_process'

export interface RunOptions {
  input?: string
  /** Exit codes treated as success (default [0]). */
  okCodes?: number[]
  timeout?: number
  maxBuffer?: number
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

const BASE_ENV: NodeJS.ProcessEnv = {
  // Never block on credential/username prompts; never take the index lock for reads.
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C'
}

export function run(file: string, cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeout ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, ...BASE_ENV }
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 })
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number' && (opts.okCodes ?? [0]).includes(code)) {
          return resolve({ stdout, stderr, code })
        }
        const detail = (stderr || stdout || err.message).trim()
        reject(new GitError(detail || `${file} failed`, code, stderr))
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export function git(cwd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  return run('git', cwd, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], opts)
}

/** Like `git`, but pathspecs are taken literally so file names with `*`, `:` etc. are safe. */
export function gitPaths(cwd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  return git(cwd, ['--literal-pathspecs', ...args], opts)
}
