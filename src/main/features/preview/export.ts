// MP4 export sink: the renderer encodes frames (WebCodecs + mediabunny) and streams the muxed bytes here.
// Bytes go to `<target>.part` at the offsets the muxer asks for; the file is renamed into place only when
// the export finishes, so a cancelled export never leaves a broken .mp4 behind.

import { app, dialog, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionDir } from './paths'

interface OpenExport {
  path: string
  handle: FileHandle
}

const exports = new Map<string, OpenExport>()
/** Finished exports, the only paths `showInFolder` reveals. */
const finished = new Set<string>()

function safeName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // eslint-disable-next-line no-control-regex -- control characters are invalid in Windows file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return (base || 'motion').slice(0, 80)
}

/** Save dialog for the .mp4; defaults to the session folder and a name derived from the title. */
export async function exportDialog(
  win: BrowserWindow | undefined,
  sessionId: string,
  title: string
): Promise<string | undefined> {
  let dir: string
  try {
    dir = sessionDir(sessionId)
  } catch {
    dir = app.getPath('videos')
  }
  const opts: Electron.SaveDialogOptions = {
    title: 'Exportar MP4',
    defaultPath: join(dir, `${safeName(String(title ?? ''))}.mp4`),
    filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }],
    properties: ['showOverwriteConfirmation']
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return undefined
  return res.filePath.toLowerCase().endsWith('.mp4') ? res.filePath : `${res.filePath}.mp4`
}

export async function exportOpen(path: string): Promise<string> {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.mp4')) throw new Error('Destino inválido.')
  const id = randomUUID()
  exports.set(id, { path, handle: await open(`${path}.part`, 'w') })
  return id
}

export async function exportWrite(id: string, position: number, data: Uint8Array): Promise<void> {
  const exp = exports.get(id)
  if (!exp) throw new Error('Exportação não encontrada.')
  await exp.handle.write(data, 0, data.byteLength, position)
}

/** Closes the export; `commit` moves the .part file into place, otherwise it is deleted. */
export async function exportClose(id: string, commit: boolean): Promise<void> {
  const exp = exports.get(id)
  if (!exp) return
  exports.delete(id)
  await exp.handle.close()
  const part = `${exp.path}.part`
  if (commit) {
    if (existsSync(exp.path)) await rm(exp.path, { force: true })
    await rename(part, exp.path)
    finished.add(exp.path)
  } else {
    await rm(part, { force: true })
  }
}

export function showInFolder(path: string): void {
  if (finished.has(path)) shell.showItemInFolder(path)
}

/** Drops unfinished exports (called on quit). */
export async function disposeExports(): Promise<void> {
  for (const id of [...exports.keys()]) await exportClose(id, false).catch(() => {})
}
