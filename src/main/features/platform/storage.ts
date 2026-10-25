// Files of the platform feature in <userData>/hangar-data/platform/:
//   config.json   { url, mode } chosen in the app (Windows policy overrides them)
//   device.json   { deviceId, registeredAt?, … } — the UUID that identifies this install to the platform
//   clients.json  { [platformUrl]: { clientId, registeredAt } } — dynamic registration cache
//   account.json  last /api/app/me seen (user, org), to show while offline; no secrets
//   tokens.json   { data } — the TokenSet as JSON, encrypted with safeStorage (DPAPI on Windows)
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PlatformError } from './errors'
import type { TokenSet } from './oauth'

export function platformDir(): string {
  const dir = join(app.getPath('userData'), 'hangar-data', 'platform')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const file = (name: string) => join(platformDir(), name)

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(name: string, value: unknown): void {
  const target = file(name)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

export function removeFile(name: string): void {
  rmSync(file(name), { force: true })
}

const TOKENS = 'tokens.json'

export async function loadTokens(): Promise<TokenSet | undefined> {
  const stored = readJson<{ data?: string }>(TOKENS, {})
  if (!stored.data) return undefined
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return undefined
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.data, 'base64'))
    const tokens = JSON.parse(result) as TokenSet
    if (!tokens.accessToken || !tokens.url) return undefined
    if (shouldReEncrypt) await saveTokens(tokens)
    return tokens
  } catch {
    // Encrypted by another Windows user or machine: behave as logged out.
    return undefined
  }
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new PlatformError(
      'storage',
      'A criptografia do sistema (safeStorage/DPAPI) não está disponível, então o Hangar não pode guardar o login.'
    )
  const data = (await safeStorage.encryptStringAsync(JSON.stringify(tokens))).toString('base64')
  writeJson(TOKENS, { data })
}

export function clearTokens(): void {
  removeFile(TOKENS)
}
