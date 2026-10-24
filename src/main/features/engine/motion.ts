// "Saída: Motion": the hidden instructions sent with a turn, and the result cards for *.motion.json files.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../../core/store'
import { MOTION_GUIDE } from '../../../shared/motion/guide'
import { MOTION_EXTENSION, parseMotion, totalDuration } from '../../../shared/motion/spec'
import type { EntryDraft } from './convert'
import { filesFor } from './files'

const MAX_LISTED = 20

export function isMotionPath(path: string): boolean {
  return path.toLowerCase().endsWith(MOTION_EXTENSION)
}

async function describe(absPath: string): Promise<string> {
  try {
    const { spec, errors } = parseMotion(await readFile(absPath, 'utf8'))
    if (!spec) return `invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`
    return `"${spec.title}", ${spec.scenes.length} scenes, ${totalDuration(spec)} s`
  } catch {
    return 'unreadable'
  }
}

/**
 * Extra text block appended to the user's message for a Motion turn: the authoring guide plus the animations
 * already in the session folder, so adjustments edit the existing file instead of creating another one.
 * Only Claude sees it; the Hangar transcript keeps the user's text and an `output: 'motion'` mark.
 */
export async function motionInstructions(sessionId: string): Promise<string> {
  const s = db('sessions').get(sessionId)
  const cwd = s ? (s.worktree?.path ?? s.cwd) : undefined
  const existing = cwd ? (await filesFor(sessionId)).filter(isMotionPath).slice(0, MAX_LISTED) : []
  const listing = existing.length
    ? (await Promise.all(existing.map(async (rel) => `- ${rel} — ${await describe(join(cwd!, rel))}`))).join('\n')
    : '- (none yet)'
  return [
    '<hangar-output-mode name="motion">',
    MOTION_GUIDE.trim(),
    '',
    '## Animations already in this folder',
    'If the request adjusts one of these, Edit that file in place (keep every id) instead of creating a new one.',
    listing,
    '</hangar-output-mode>'
  ].join('\n')
}

/** Transcript card for a motion file written or edited during a turn (small file: read synchronously). */
export function motionCard(path: string): EntryDraft {
  try {
    const { spec, errors } = parseMotion(readFileSync(path, 'utf8'))
    if (!spec) return { kind: 'motion', path, errors }
    return { kind: 'motion', path, title: spec.title, duration: totalDuration(spec), scenes: spec.scenes.length, errors: [] }
  } catch (err) {
    return { kind: 'motion', path, errors: [`Não foi possível ler o arquivo: ${err instanceof Error ? err.message : String(err)}`] }
  }
}
