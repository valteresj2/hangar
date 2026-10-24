// Artifacts: HTML / SVG / Markdown / Mermaid files written during a session.
// Registered automatically from the engine's `session:file-written` bus event (or added by hand),
// persisted in <userData>/hangar-data/preview/artifacts.json.

import { dialog, nativeTheme, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { broadcast } from '../../core/broadcast'
import {
  ARTIFACT_EXTENSIONS,
  PREVIEW,
  type Artifact,
  type ArtifactContent,
  type ArtifactsEvent
} from '../../../shared/features/preview'
import { artifactUrl } from './artifactServer'
import { previewDataDir, sessionDir } from './paths'

const MAX_READ_BYTES = 5 * 1024 * 1024

let artifacts: Artifact[] = []
let saveTimer: NodeJS.Timeout | undefined

function storeFile(): string {
  return join(previewDataDir(), 'artifacts.json')
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function loadArtifacts(): void {
  try {
    const rows = JSON.parse(readFileSync(storeFile(), 'utf8')) as Artifact[]
    artifacts = Array.isArray(rows) ? rows : []
  } catch {
    artifacts = []
  }
}

export function flushArtifacts(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  const file = storeFile()
  writeFileSync(`${file}.tmp`, JSON.stringify(artifacts, null, 2), 'utf8')
  renameSync(`${file}.tmp`, file)
}

function changed(sessionId: string, artifactId?: string): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushArtifacts, 200)
  broadcast(PREVIEW.artifactsEvent, { sessionId, artifactId } satisfies ArtifactsEvent)
}

export function artifactKind(path: string) {
  return ARTIFACT_EXTENSIONS[extname(path).toLowerCase()]
}

export function findArtifact(id: string): Artifact | undefined {
  return artifacts.find((a) => a.id === id)
}

export function listArtifacts(sessionId: string): Artifact[] {
  return artifacts.filter((a) => a.sessionId === sessionId).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Registers (or bumps) a file as an artifact of the session. Returns undefined for unsupported files. */
export function registerArtifact(sessionId: string, rawPath: string): Artifact | undefined {
  let path = rawPath
  if (!isAbsolute(path)) {
    try {
      path = resolve(sessionDir(sessionId), path)
    } catch {
      return undefined
    }
  }
  path = resolve(path)
  const kind = artifactKind(path)
  if (!kind) return undefined

  const now = Date.now()
  const existing = artifacts.find((a) => a.sessionId === sessionId && samePath(a.path, path))
  if (existing) {
    existing.updatedAt = now
    changed(sessionId, existing.id)
    return existing
  }
  const artifact: Artifact = { id: randomUUID(), sessionId, path, name: basename(path), kind, addedAt: now, updatedAt: now }
  artifacts.push(artifact)
  changed(sessionId, artifact.id)
  return artifact
}

export function removeArtifact(id: string): boolean {
  const artifact = findArtifact(id)
  if (!artifact) return false
  artifacts = artifacts.filter((a) => a.id !== id)
  changed(artifact.sessionId)
  return true
}

/** Drops artifacts of sessions that no longer exist. */
export function pruneSession(sessionId: string): void {
  const before = artifacts.length
  artifacts = artifacts.filter((a) => a.sessionId !== sessionId)
  if (artifacts.length !== before) changed(sessionId)
}

/** Reads a registered artifact. Only paths that are registered artifacts can be read. */
export async function readArtifact(pathOrId: string): Promise<ArtifactContent> {
  const target = resolve(pathOrId)
  const artifact = findArtifact(pathOrId) ?? artifacts.find((a) => samePath(a.path, target))
  if (!artifact) throw new Error('Arquivo não registrado como artifact.')
  if (!existsSync(artifact.path)) throw new Error('O arquivo não existe mais no disco.')

  const stat = statSync(artifact.path)
  const handle = await open(artifact.path, 'r')
  try {
    const length = Math.min(stat.size, MAX_READ_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const framed = artifact.kind === 'html' || artifact.kind === 'mermaid'
    let url = framed ? artifactUrl(artifact) : undefined
    if (url && artifact.kind === 'mermaid' && nativeTheme.shouldUseDarkColors) url += '?theme=dark'
    return {
      artifact,
      content: buffer.toString('utf8'),
      mtime: stat.mtimeMs,
      size: stat.size,
      url,
      truncated: stat.size > MAX_READ_BYTES || undefined
    }
  } finally {
    await handle.close()
  }
}

/** Adds a file by hand; without a path, asks the user to pick one. */
export async function addArtifactInteractive(win: BrowserWindow | undefined, sessionId: string, path?: string): Promise<Artifact | undefined> {
  if (!path) {
    let defaultPath: string | undefined
    try {
      defaultPath = sessionDir(sessionId)
    } catch {
      defaultPath = undefined
    }
    const opts: Electron.OpenDialogOptions = {
      title: 'Abrir arquivo como artifact',
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: 'Artifacts', extensions: Object.keys(ARTIFACT_EXTENSIONS).map((e) => e.slice(1)) }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return undefined
    path = res.filePaths[0]
  }
  if (!artifactKind(path)) throw new Error('Tipo de arquivo não suportado (use .html, .htm, .svg, .md ou .mermaid).')
  return registerArtifact(sessionId, path)
}

export function revealArtifact(id: string): void {
  const artifact = findArtifact(id)
  if (artifact) shell.showItemInFolder(artifact.path)
}

/** Opens the file outside Hangar: HTML/SVG in the system browser, others in the default app. */
export async function openArtifactExternally(id: string): Promise<void> {
  const artifact = findArtifact(id)
  if (!artifact) return
  if (artifact.kind === 'html' || artifact.kind === 'svg') await shell.openExternal(pathToFileURL(artifact.path).href)
  else {
    const err = await shell.openPath(artifact.path)
    if (err) throw new Error(err)
  }
}
