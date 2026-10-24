// One proposer/composer stage: build its context directory, run a headless Claude Code query that
// may only edit `harness/`, harvest and validate the result, retry an invalid proposal once and
// otherwise inherit the harness the stage started from (as harness2's recursion._run_stage does).
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isHarnessPath, type HarnessSnapshot, type HarnessTree, type Lesson } from '../../../shared/harness'
import { settings } from '../../core/store'
import { claudeLaunchOptions, loadSdk } from '../engine/sdk'
import { mission, retryNote } from './prompts'
import { labDir } from './store'
import { sameTree, validateTree } from './validate'

/** A finished run the stage can read. */
export interface RunEvidence {
  label: string
  status: string
  trajectory: string
  finalAnswer: string
  changes: string
  costUsd?: number
  durationMs?: number
}

/** A candidate harness (with the notes of the stage that produced it). */
export interface CandidateEvidence {
  label: string
  tree: HarnessTree
  notes: string
}

export interface StageInput {
  roundId: string
  stageId: string
  job: string
  task: string
  baseTree: HarnessTree
  /** The harness the stage edits; also what it inherits when both attempts fail. */
  currentTree: HarnessTree
  runs: RunEvidence[]
  candidates: CandidateEvidence[]
  lessons: Lesson[]
  examples: HarnessSnapshot[]
  model?: string
  signal: AbortSignal
}

export interface StageOutput {
  tree: HarnessTree
  notes: string
  keptBase: boolean
  fellBack: boolean
  error?: string
  costUsd: number
  durationMs: number
  attempts: number
}

const STAGE_ATTEMPTS = 2
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit'])
const NOTES = /<notes>([\s\S]*?)<\/notes>/

export function stageDir(roundId: string, stageId: string): string {
  return join(labDir(), 'ctx', roundId, stageId)
}

async function writeTree(dir: string, tree: HarnessTree): Promise<void> {
  for (const [path, text] of Object.entries(tree)) {
    const file = join(dir, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
}

/** Every file under `dir` as a tree; paths off the harness surface are reported, empty files dropped. */
async function readTreeDir(dir: string): Promise<{ tree: HarnessTree; rejected: string[] }> {
  const tree: HarnessTree = {}
  const rejected: string[] = []
  const walk = async (current: string) => {
    for (const d of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const abs = join(current, d.name)
      if (d.isDirectory()) await walk(abs)
      else if (d.isFile()) {
        const rel = relative(dir, abs).replace(/\\/g, '/')
        const text = await readFile(abs, 'utf8')
        if (!text.trim()) continue
        if (isHarnessPath(rel)) tree[rel] = text
        else rejected.push(rel)
      }
    }
  }
  await walk(dir)
  return { tree, rejected }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item'
}

/** Writes the evidence directory and returns the layout text for the mission. */
async function buildContext(dir: string, input: StageInput): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'task.md'), `${input.task.trim()}\n`, 'utf8')
  await writeTree(join(dir, 'base_harness'), input.baseTree)
  await writeTree(join(dir, 'harness'), input.currentTree)
  for (const run of input.runs) {
    const d = join(dir, 'runs', run.label)
    await mkdir(d, { recursive: true })
    const meta = [`status: ${run.status}`, run.costUsd !== undefined ? `cost_usd: ${run.costUsd.toFixed(4)}` : '', run.durationMs !== undefined ? `duration_s: ${Math.round(run.durationMs / 1000)}` : '']
    await writeFile(join(d, 'trajectory.md'), `${meta.filter(Boolean).join('\n')}\n\n${run.trajectory}\n`, 'utf8')
    await writeFile(join(d, 'final.md'), `${run.finalAnswer || '(no final answer)'}\n`, 'utf8')
    await writeFile(join(d, 'changes.patch'), `${run.changes || '(no file changes)'}\n`, 'utf8')
  }
  for (const c of input.candidates) {
    const d = join(dir, 'candidates', c.label)
    await writeTree(join(d, 'harness'), c.tree)
    await writeFile(join(d, 'notes.md'), `${c.notes || '(no notes)'}\n`, 'utf8')
  }
  const lib = join(dir, 'library')
  await mkdir(lib, { recursive: true })
  const lessons = input.lessons.filter((l) => l.enabled)
  await writeFile(
    join(lib, 'lessons.md'),
    lessons.length
      ? lessons.map((l) => `- when ${l.cue}: ${l.lesson}\n  evidence: ${l.evidence} (confidence: ${l.confidence})`).join('\n') + '\n'
      : '(no lessons recorded for this project yet)\n',
    'utf8'
  )
  for (const s of input.examples) {
    const d = join(lib, 'snapshots', `${slug(s.label)}-${s.id}`)
    await writeTree(join(d, 'harness'), s.tree)
    await writeFile(join(d, 'note.md'), `${s.label}\n\n${s.note ?? ''}\n`, 'utf8')
  }

  const lines = [
    '    task.md                          the task, verbatim',
    '    base_harness/                    the original (unmodified) harness',
    '    harness/                         the harness you edit -- the ONLY place you may write',
    ...input.runs.map((r) => `    runs/${r.label}/`.padEnd(37) + 'trajectory.md, final.md, changes.patch of that run'),
    ...input.candidates.map((c) => `    candidates/${c.label}/`.padEnd(37) + 'harness/ and notes.md of that candidate'),
    '    library/lessons.md               lessons recorded in earlier work on this project',
    ...(input.examples.length ? ['    library/snapshots/               harnesses adopted in earlier Lab rounds (examples)'] : [])
  ]
  return lines.join('\n')
}

interface CallResult {
  text: string
  costUsd: number
  error?: string
}

async function callProposer(dir: string, prompt: string, model: string, signal: AbortSignal): Promise<CallResult> {
  const sdk = await loadSdk()
  const inside = (p: unknown): string | undefined => {
    if (typeof p !== 'string' || !p) return undefined
    const rel = relative(dir, resolve(dir, p))
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel.replace(/\\/g, '/')
  }
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (READ_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.path
      if (target === undefined || inside(target) !== undefined) return { behavior: 'allow', updatedInput: input }
      return { behavior: 'deny', message: 'Only files inside your working directory can be read.' }
    }
    if (WRITE_TOOLS.has(toolName)) {
      const rel = inside(input.file_path)
      if (!rel?.startsWith('harness/')) return { behavior: 'deny', message: 'Only files under harness/ can be changed.' }
      const harnessRel = rel.slice('harness/'.length)
      if (!isHarnessPath(harnessRel)) {
        return {
          behavior: 'deny',
          message: `${harnessRel} is not on the harness surface (CLAUDE.md, .claude/CLAUDE.md, .claude/skills/<name>/…, .claude/agents/<name>.md, .claude/commands/….md, .claude/settings.json, .claude/scripts/…).`
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `${toolName} is not available here: only Read, Glob, Grep, Write and Edit.` }
  }

  const abortController = new AbortController()
  const onAbort = () => abortController.abort()
  signal.addEventListener('abort', onAbort)
  let text = ''
  let costUsd = 0
  let error: string | undefined
  try {
    const q = sdk.query({
      prompt,
      options: {
        cwd: dir,
        model,
        permissionMode: 'default',
        tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
        disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'MultiEdit', 'TodoWrite'],
        canUseTool,
        settingSources: [],
        persistSession: false,
        maxTurns: 80,
        abortController,
        // Provider profile: executable, environment and the flag-settings env that outranks ~/.claude/settings.json.
        ...claudeLaunchOptions()
      }
    })
    for await (const m of q) {
      if (m.type === 'assistant') {
        const blocks = (m.message as { content?: unknown }).content
        if (Array.isArray(blocks)) {
          for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') text += `${b.text}\n`
        }
      } else if (m.type === 'result') {
        costUsd = m.total_cost_usd
        if (m.subtype === 'success') text = m.result || text
        // Out of turns still leaves the edits on disk: harvest them like a normal reply.
        else if (m.subtype !== 'error_max_turns') error = m.errors.join('\n') || m.subtype
      }
    }
  } catch (err) {
    error = signal.aborted ? 'Interrompida.' : err instanceof Error ? err.message : String(err)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return { text, costUsd, error }
}

export async function runStage(input: StageInput): Promise<StageOutput> {
  const started = Date.now()
  const dir = stageDir(input.roundId, input.stageId)
  const model = input.model || settings().get().defaultModel
  const inherit = (error: string, costUsd: number, attempts: number): StageOutput => ({
    tree: { ...input.currentTree },
    notes: '',
    keptBase: true,
    fellBack: true,
    error: error.slice(0, 600),
    costUsd,
    durationMs: Date.now() - started,
    attempts
  })

  let layout: string
  try {
    layout = await buildContext(dir, input)
  } catch (err) {
    return inherit(`Não foi possível montar a evidência: ${err instanceof Error ? err.message : String(err)}`, 0, 0)
  }
  // Test hook: HANGAR_LAB_TEST_INSTRUCTION is appended to every mission (E2E check of the write guard).
  const testNote = process.env.HANGAR_LAB_TEST_INSTRUCTION
  const base = mission(input.job, layout) + (testNote ? `\n\n# TEST INSTRUCTION\n\n${testNote}` : '')

  let err = ''
  let costUsd = 0
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    if (input.signal.aborted) return inherit('Interrompida.', costUsd, attempt - 1)
    const reply = await callProposer(dir, base + (err ? retryNote(err) : ''), model, input.signal)
    costUsd += reply.costUsd
    // A failed call is not a proposal: inherit right away (harness2 does the same on transport errors).
    if (reply.error) return inherit(reply.error, costUsd, attempt)

    const harnessDir = join(dir, 'harness')
    if (!existsSync(harnessDir)) {
      err = 'The `harness/` directory is gone; edit the files in `harness/` in place.'
      await writeTree(harnessDir, input.currentTree)
      continue
    }
    const { tree, rejected } = await readTreeDir(harnessDir)
    if (rejected.length) {
      err = `These files are off the harness surface and were not applied: ${rejected.slice(0, 6).join(', ')}. Remove them (empty them) or move them onto the surface.`
      continue
    }
    const invalid = validateTree(tree, input.currentTree, input.stageId)
    if (invalid) {
      err = invalid
      continue
    }
    const notes = NOTES.exec(reply.text)?.[1].trim() ?? reply.text.trim()
    return {
      tree,
      notes: notes.slice(0, 6000),
      keptBase: sameTree(tree, input.currentTree),
      fellBack: false,
      costUsd,
      durationMs: Date.now() - started,
      attempts: attempt
    }
  }
  return inherit(`Proposta inválida duas vezes; herdou o harness atual. Último erro: ${err}`, costUsd, STAGE_ATTEMPTS)
}
