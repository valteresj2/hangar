// Slash commands of a project as the Hangar engine sees them: the Markdown files under .hangar/commands and
// .claude/commands (the harness expands "/name args" itself; see resources/harness/hangar/project.py). Listing them
// here lets the composer offer them before the session's process exists.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { SlashCommandInfo } from '../../../../shared/features/engine'

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.md')) out.push(full)
  }
  return out
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  const meta: Record<string, string> = {}
  for (const line of m?.[1].split('\n') ?? []) {
    const i = line.indexOf(':')
    if (i > 0 && !/^[\s-]/.test(line))
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
  }
  return meta
}

export function projectCommands(cwd: string): SlashCommandInfo[] {
  const found = new Map<string, SlashCommandInfo>()
  for (const root of [join(cwd, '.hangar', 'commands'), join(cwd, '.claude', 'commands')]) {
    for (const file of walk(root).sort()) {
      const name = relative(root, file).slice(0, -'.md'.length).split(sep).join(':')
      if (found.has(name)) continue
      let meta: Record<string, string>
      try {
        meta = frontmatter(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      found.set(name, {
        name,
        description: meta.description ?? '',
        argumentHint: meta['argument-hint'] || undefined
      })
    }
  }
  return [...found.values()]
}
