// Artifacts: HTML / SVG / Markdown / Mermaid / Motion files written during a session.
// Registered automatically from the engine's `session:file-written` bus event (or added by hand),
// persisted in <userData>/hangar-data/preview/artifacts.json.

import { dialog, nativeTheme, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { broadcast } from '../../core/broadcast'
import {
  ARTIFACT_EXTENSIONS,
  PREVIEW,
  artifactKindOf,
  type Artifact,
  type ArtifactContent,
  type ArtifactStat,
  type ArtifactsEvent,
  type ArtifactWriteResult,
  type MotionAssetUrls
} from '../../../shared/features/preview'
import { MOTION_EXTENSION } from '../../../shared/motion/spec'
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
  return artifactKindOf(path)
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
      filters: [{ name: 'Artifacts', extensions: [MOTION_EXTENSION.slice(1), ...Object.keys(ARTIFACT_EXTENSIONS).map((e) => e.slice(1))] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return undefined
    path = res.filePaths[0]
  }
  if (!artifactKind(path)) throw new Error('Tipo de arquivo não suportado (use .html, .htm, .svg, .md, .mermaid ou .motion.json).')
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
  if (artifact.kind === 'html' || artifact.kind === 'svg') {
    // Agent-written pages run with file:// privileges in the system browser: ask first.
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Abrir no navegador', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Abrir artifact fora do Hangar',
      message: 'Abrir este arquivo no navegador do sistema?',
      detail: `${artifact.path}

Ele foi gerado pelo agente e, fora do Hangar, roda sem o isolamento do painel Artifacts.`
    })
    if (response === 0) await shell.openExternal(pathToFileURL(artifact.path).href)
  }
  else {
    const err = await shell.openPath(artifact.path)
    if (err) throw new Error(err)
  }
}

export async function statArtifact(id: string): Promise<ArtifactStat> {
  const artifact = findArtifact(id)
  if (!artifact) return { exists: false, mtime: 0 }
  try {
    return { exists: true, mtime: (await stat(artifact.path)).mtimeMs }
  } catch {
    return { exists: false, mtime: 0 }
  }
}

/** Saves edited text over a registered motion artifact (the only kind the UI can edit). */
export async function writeArtifact(id: string, text: string): Promise<ArtifactWriteResult> {
  const artifact = findArtifact(id)
  if (!artifact) throw new Error('Artifact não encontrado.')
  if (artifact.kind !== 'motion') throw new Error('Só arquivos .motion.json podem ser editados aqui.')
  if (typeof text !== 'string') throw new Error('Conteúdo inválido.')
  const tmp = `${artifact.path}.hangar-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, artifact.path)
  return { mtime: statSync(artifact.path).mtimeMs }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Loads the image files a motion spec references as data: URLs (the app CSP cannot load file: or loopback
 * images). `src` is relative to the .motion.json folder or absolute; only image files are read.
 */
export async function motionAssets(id: string, srcs: string[]): Promise<MotionAssetUrls> {
  const artifact = findArtifact(id)
  if (!artifact || artifact.kind !== 'motion' || !Array.isArray(srcs)) return {}
  const out: MotionAssetUrls = {}
  await Promise.all(
    srcs.slice(0, 200).map(async (src) => {
      if (typeof src !== 'string' || /^(data:|https?:)/i.test(src)) return
      const file = resolve(dirname(artifact.path), src.replace(/^file:\/\/\/?/i, ''))
      const mime = IMAGE_MIME[extname(file).toLowerCase()]
      if (!mime) return
      try {
        if ((await stat(file)).size > MAX_IMAGE_BYTES) return
        out[src] = `data:${mime};base64,${(await readFile(file)).toString('base64')}`
      } catch {
        // missing image: drawn as a placeholder
      }
    })
  )
  return out
}
