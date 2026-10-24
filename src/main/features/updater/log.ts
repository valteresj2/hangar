// Small append-only file logger for the updater (<logs>/updater.log, rotated at 1 MB).
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_BYTES = 1024 * 1024

export function logFilePath(): string {
  return join(app.getPath('logs'), 'updater.log')
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: string, args: unknown[]): void {
  const file = logFilePath()
  try {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`)
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}\n`, 'utf8')
  } catch {
    // Logging must never break updates.
  }
}

/** Matches electron-updater's Logger interface. */
export const fileLogger = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
  debug: (...args: unknown[]) => write('debug', args)
}
