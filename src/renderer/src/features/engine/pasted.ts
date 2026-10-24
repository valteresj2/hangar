// Images without a file path (clipboard, drops from a browser): read, shrink if needed, keep as base64.
import { ENGINE, type PastedImage } from '@shared/features/engine'
import { bridge } from '../../core/api'

export type ComposerImage = PastedImage & { id: string; url: string }

const MAX_BYTES = 5 * 1024 * 1024
const MAX_EDGE = 2048
const SUPPORTED = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Re-encodes as JPEG, shrinking until it fits the 5 MB limit. */
async function recompress(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) break
      // JPEG has no alpha: paint transparent areas white instead of black.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
      if (out && out.size <= MAX_BYTES) return out
      scale *= 0.7
    }
  } finally {
    bitmap.close()
  }
  throw new Error('Não foi possível reduzir a imagem para menos de 5 MB.')
}

export async function blobToImage(blob: Blob): Promise<ComposerImage> {
  let source = blob
  if (!SUPPORTED.has(blob.type) || blob.size > MAX_BYTES) source = await recompress(blob)
  const mediaType = source.type as PastedImage['mediaType']
  const data = await readAsBase64(source)
  return { id: crypto.randomUUID(), mediaType, data, url: `data:${mediaType};base64,${data}` }
}

const thumbs = new Map<string, Promise<string | undefined>>()

/** Data URL of an image saved by the engine (transcript thumbnails). */
export function savedImageUrl(path: string): Promise<string | undefined> {
  let p = thumbs.get(path)
  if (!p) {
    p = bridge.invoke<string | undefined>(ENGINE.readImage, path).catch(() => undefined)
    thumbs.set(path, p)
  }
  return p
}
