// Read-only listing of installed skills and plugins under ~/.claude.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { PluginInfo, SkillInfo } from '../../../shared/features/settings'

export const claudeDir = (): string => join(homedir(), '.claude')

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJson<T>(file: string): T | undefined {
  const text = readText(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

function unquote(v: string): string {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'")
  }
  return s
}

/** Minimal YAML frontmatter reader: top-level scalar keys, including `|` / `>` blocks. */
export function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key, value] = kv
    if (/^[|>][+-]?$/.test(value.trim())) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim())
      out[key] = block.join(value.trim().startsWith('>') ? ' ' : '\n').trim()
    } else {
      out[key] = unquote(value)
    }
  }
  return out
}

function readSkill(dir: string, source: SkillInfo['source']): SkillInfo | undefined {
  const md = readText(join(dir, 'SKILL.md'))
  if (md === undefined) return undefined
  const fm = frontmatter(md)
  return { name: fm.name || basename(dir), description: fm.description ?? '', dir, source }
}

export function listSkills(): SkillInfo[] {
  const root = join(claudeDir(), 'skills')
  const skills: SkillInfo[] = []
  for (const dir of subdirs(root)) {
    const skill = readSkill(dir, 'user')
    if (skill) skills.push(skill)
  }
  // Skills synced from claude.ai live one level deeper: skills/synced/<bucket>/<skill>/SKILL.md.
  for (const bucket of subdirs(join(root, 'synced'))) {
    for (const dir of subdirs(bucket)) {
      const skill = readSkill(dir, 'synced')
      if (skill) skills.push(skill)
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

type InstallRecord = { scope?: string; installPath?: string; version?: string; projectPath?: string }

export function listPlugins(): PluginInfo[] {
  const pluginsDir = join(claudeDir(), 'plugins')
  const installed = readJson<{ plugins?: Record<string, InstallRecord | InstallRecord[]> }>(join(pluginsDir, 'installed_plugins.json'))
  const enabledMap = readJson<{ enabledPlugins?: Record<string, boolean> }>(join(claudeDir(), 'settings.json'))?.enabledPlugins ?? {}

  const plugins: PluginInfo[] = []
  for (const [id, value] of Object.entries(installed?.plugins ?? {})) {
    const records = Array.isArray(value) ? value : [value]
    const [name, marketplace] = id.split('@')
    for (const rec of records.length ? records : [{}]) {
      const manifest = rec.installPath
        ? readJson<{ description?: string; version?: string }>(join(rec.installPath, '.claude-plugin', 'plugin.json'))
        : undefined
      plugins.push({
        id,
        name,
        marketplace,
        version: rec.version ?? manifest?.version,
        description: manifest?.description,
        scope: rec.scope,
        enabled: id in enabledMap ? enabledMap[id] : undefined,
        installPath: rec.installPath && existsSync(rec.installPath) ? rec.installPath : undefined
      })
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}
