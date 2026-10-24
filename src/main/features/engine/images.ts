// Pasted images: saved under <userData>/hangar-data/engine/images/<sessionId>/ so transcripts can reference them.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve, isAbsolute } from 'node:path'
import type { PastedImage } from '../../../shared/features/engine'

const EXT: Record<PastedImage['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}
const MEDIA: Record<string, PastedImage['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function imagesRoot(): string {
  return join(app.getPath('userData'), 'hangar-data', 'engine', 'images')
}

export function mediaTypeFor(path: string): PastedImage['mediaType'] | undefined {
  return MEDIA[extname(path).toLowerCase()]
}

export function isValidImage(img: PastedImage): boolean {
  return img.mediaType in EXT && typeof img.data === 'string' && img.data.length > 0 && img.data.length <= (MAX_IMAGE_BYTES * 4) / 3 + 4
}

/** Writes a pasted image next to the session's other images and returns its absolute path. */
export async function saveImage(sessionId: string, img: PastedImage): Promise<string> {
  const dir = join(imagesRoot(), sessionId.replace(/[^\w-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}${EXT[img.mediaType]}`)
  await writeFile(path, Buffer.from(img.data, 'base64'))
  return path
}

/** Only files inside the images folder can be read back (the path comes from the renderer). */
function insideRoot(path: string): boolean {
  const rel = relative(imagesRoot(), resolve(path))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export async function loadImage(path: string): Promise<PastedImage | undefined> {
  const mediaType = mediaTypeFor(path)
  if (!mediaType || !insideRoot(path)) return undefined
  try {
    return { mediaType, data: (await readFile(path)).toString('base64') }
  } catch {
    return undefined
  }
}

export async function imageDataUrl(path: string): Promise<string | undefined> {
  const img = await loadImage(path)
  return img && `data:${img.mediaType};base64,${img.data}`
}
