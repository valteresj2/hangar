// Validation of a proposed harness tree (the rules the proposer prompt announces).
// Mirrors harness2's validate-before-rollout step, rewritten for the Claude Code surface.
import { isHarnessPath, type HarnessTree } from '../../../shared/harness'
import { execChanges } from './exec'

const ALWAYS_ON_LIMIT = 20_000
/** Paths a component may reference under .claude/ (must exist in the tree when named). */
const REFERENCE = /\.claude\/(?:scripts\/[\w.\-/]+|skills\/[\w.-]+\/[\w.\-/]+|agents\/[\w.-]+\.md)/g

function frontmatter(text: string): Record<string, string> | undefined {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return undefined
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Returns why the tree is not acceptable, or undefined when it is.
 * `stageId` exists for the test hook HANGAR_LAB_SIMULATE_INVALID (comma-separated stage ids, or "*").
 */
export function validateTree(tree: HarnessTree, fallback: HarnessTree, stageId?: string): string | undefined {
  const simulate = process.env.HANGAR_LAB_SIMULATE_INVALID?.split(',').map((s) => s.trim())
  if (stageId && simulate && (simulate.includes('*') || simulate.includes(stageId))) {
    return 'Simulated invalid proposal (HANGAR_LAB_SIMULATE_INVALID test hook).'
  }
  const paths = Object.keys(tree)
  if (!paths.length && Object.keys(fallback).length) {
    return '`harness/` came back empty -- edit the files, do not empty them all.'
  }
  const problems: string[] = []
  // Proposals run unattended in the variants' worktrees: they may not add or change anything that executes.
  const exec = execChanges(fallback, tree)
  if (exec.length) {
    problems.push(
      `Automatic proposals may not change hooks, scripts, commands or permissions (found: ${exec
        .slice(0, 4)
        .map((c) => `${c.kind} in ${c.path}`)
        .join('; ')}). Encode the improvement as instructions, skills or subagents instead.`
    )
  }
  const off = paths.filter((p) => !isHarnessPath(p))
  if (off.length) problems.push(`Off the harness surface: ${off.slice(0, 6).join(', ')}.`)

  const skillDirs = new Set(paths.map((p) => /^\.claude\/skills\/([^/]+)\//.exec(p)?.[1]).filter((d): d is string => !!d))
  for (const dir of skillDirs) {
    const skill = tree[`.claude/skills/${dir}/SKILL.md`]
    if (skill === undefined) {
      problems.push(`.claude/skills/${dir}/ has no SKILL.md.`)
      continue
    }
    const fm = frontmatter(skill)
    if (!fm) problems.push(`.claude/skills/${dir}/SKILL.md has no YAML frontmatter (--- name / description ---).`)
    else {
      if (fm.name !== dir) problems.push(`.claude/skills/${dir}/SKILL.md: frontmatter name must be "${dir}" (got "${fm.name ?? ''}").`)
      if (!fm.description) problems.push(`.claude/skills/${dir}/SKILL.md: frontmatter needs a description (the trigger).`)
    }
  }

  for (const p of paths.filter((x) => /^\.claude\/agents\/[^/]+\.md$/.test(x))) {
    const fm = frontmatter(tree[p])
    if (!fm?.name || !fm.description) problems.push(`${p}: subagent frontmatter needs name and description.`)
  }

  const settings = tree['.claude/settings.json']
  if (settings !== undefined) {
    try {
      const parsed: unknown = JSON.parse(settings)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problems.push('.claude/settings.json must be a JSON object.')
    } catch (err) {
      problems.push(`.claude/settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const missing = new Set<string>()
  for (const [path, text] of Object.entries(tree)) {
    for (const ref of text.match(REFERENCE) ?? []) {
      const clean = ref.replace(/[.)\]`'"]+$/, '')
      // Only file-like references (with an extension) must exist; folders may be mentioned freely.
      if (/\.[A-Za-z0-9]+$/.test(clean) && tree[clean] === undefined && clean !== path) missing.add(clean)
    }
  }
  if (missing.size) problems.push(`Named but missing from the harness: ${[...missing].slice(0, 6).join(', ')}.`)

  const alwaysOn = (tree['CLAUDE.md'] ?? '').length + (tree['.claude/CLAUDE.md'] ?? '').length
  if (alwaysOn > ALWAYS_ON_LIMIT) {
    problems.push(`CLAUDE.md + .claude/CLAUDE.md have ${alwaysOn} characters; the limit is ${ALWAYS_ON_LIMIT}.`)
  }
  return problems.length ? problems.join('\n') : undefined
}

export function sameTree(a: HarnessTree, b: HarnessTree): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] === a[k])
}
