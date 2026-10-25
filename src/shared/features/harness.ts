// IPC channels and payload types for the "harness" feature. Owned by the harness agent.
// Domain types (HarnessTree, HarnessSnapshot, Lesson, …) live in ../harness.ts (chief-owned).
import type { HarnessComponentKind, HarnessSnapshot, HarnessTree, Lesson, Reflection } from '../harness'

export const HARNESS = {
  /** (dir) → HarnessState */
  read: 'harness:read',
  /** (dir, rel, content) → void. Rejects paths outside the harness surface. */
  writeFile: 'harness:writeFile',
  /** (dir, rel) → void */
  deleteFile: 'harness:deleteFile',
  /** (dir, kind: TemplateKind, name) → string[] (created paths). Fails if a file already exists. */
  createFromTemplate: 'harness:createFromTemplate',
  /** (projectCwd) → HarnessSnapshot[] (newest first) */
  snapshots: 'harness:snapshots',
  /** (projectCwd, label, dir?, note?) → HarnessSnapshot — snapshot of the harness in `dir` (default: the project) */
  snapshotCreate: 'harness:snapshotCreate',
  /** (projectCwd, snapshotId, dir?) → HarnessSnapshot (the automatic "restore" snapshot of the previous state) */
  snapshotRestore: 'harness:snapshotRestore',
  /** (projectCwd, snapshotId) → void */
  snapshotDelete: 'harness:snapshotDelete',
  /** (from: HarnessTree, to: HarnessTree) → TreeDiffFile[] */
  diff: 'harness:diff',
  /** (projectCwd) → Lesson[] (newest first) */
  lessons: 'harness:lessons',
  /** (lesson: Lesson, reflectionId?) → Lesson — stores a proposed (or manual) lesson */
  saveLesson: 'harness:saveLesson',
  /** (projectCwd, lessonId, patch: LessonPatch) → Lesson */
  updateLesson: 'harness:updateLesson',
  /** (projectCwd, lessonId) → void */
  deleteLesson: 'harness:deleteLesson',
  /** (projectCwd) → Reflection[] (newest first) */
  reflections: 'harness:reflections',
  /** (sessionId, opts?: ReflectSessionOptions) → ReflectProposal — the lesson is NOT stored until saveLesson */
  reflectSession: 'harness:reflectSession',

  /** HarnessChange */
  evChanged: 'harness:event:changed'
} as const

export interface HarnessState {
  dir: string
  tree: HarnessTree
  /** Harness files left out of `tree` (too large or binary). They are never deleted by a sync. */
  skipped: { path: string; reason: 'large' | 'binary' }[]
}

export interface HarnessChange {
  /** Normalized project directory (snapshots / lessons / reflections), or the directory whose files changed. */
  projectCwd?: string
  dir?: string
  what: 'files' | 'snapshots' | 'lessons' | 'reflections'
}

export type LessonPatch = Partial<Pick<Lesson, 'cue' | 'lesson' | 'evidence' | 'confidence' | 'enabled'>>

export interface ReflectSessionOptions {
  /** Model alias for the reflector; defaults to the app's default model. */
  model?: string
}

/** Result of reflecting on one session: the reflection is stored, the lesson is only a proposal. */
export interface ReflectProposal {
  reflection: Reflection
  lesson?: Lesson
  /** Snapshot used as the base, when one existed before the session started. */
  baseSnapshot?: Pick<HarnessSnapshot, 'id' | 'label' | 'createdAt'>
  /** Raw reflector output, for troubleshooting a parse that found nothing. */
  raw: string
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface TreeDiffFile {
  path: string
  status: 'added' | 'removed' | 'modified'
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

// ---- Templates (shared so the in-memory editor and the main process create the same files) ----

export type TemplateKind =
  'instructions' | 'local-instructions' | 'skill' | 'subagent' | 'command' | 'settings' | 'script'

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  instructions: 'CLAUDE.md (instruções)',
  'local-instructions': '.claude/CLAUDE.md',
  skill: 'Skill',
  subagent: 'Subagente',
  command: 'Comando (slash)',
  settings: 'settings.json (hooks e permissões)',
  script: 'Script'
}

/** Kinds that need a name typed by the user. */
export const NAMED_TEMPLATES: readonly TemplateKind[] = ['skill', 'subagent', 'command', 'script']

export const COMPONENT_LABELS: Record<HarnessComponentKind, string> = {
  instructions: 'Instruções',
  skill: 'Skills',
  subagent: 'Subagentes',
  command: 'Comandos',
  settings: 'Settings',
  script: 'Scripts'
}

/** Component names: letters, digits, dot, dash, underscore (commands and scripts may use sub-folders). */
export function validTemplateName(kind: TemplateKind, name: string): boolean {
  if (kind === 'command' || kind === 'script')
    return /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(name) && !name.split('/').includes('..')
  return /^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..'
}

/** Files a template creates (project-relative path → content). */
export function templateFiles(kind: TemplateKind, name = ''): HarnessTree {
  const n = name.trim()
  switch (kind) {
    case 'instructions':
      return {
        'CLAUDE.md': [
          '# Instruções do projeto',
          '',
          '<!-- Este texto é carregado em TODA sessão: mantenha curto e factual. -->',
          '',
          '## Contexto',
          '- O que é este projeto e onde fica o código principal.',
          '',
          '## Comandos',
          '- Build: `...`',
          '- Testes: `...`',
          '',
          '## Regras',
          '- ...',
          ''
        ].join('\n')
      }
    case 'local-instructions':
      return { '.claude/CLAUDE.md': '# Instruções adicionais\n\n- ...\n' }
    case 'skill':
      return {
        [`.claude/skills/${n}/SKILL.md`]: [
          '---',
          `name: ${n}`,
          'description: Uma frase dizendo o que a skill faz e QUANDO usá-la (é isso que o Claude lê para decidir).',
          '---',
          '',
          `# ${n}`,
          '',
          '## Quando usar',
          '- ...',
          '',
          '## Passos',
          '1. ...',
          '2. ...',
          '',
          '## Verificação',
          '- Como confirmar que deu certo.',
          ''
        ].join('\n')
      }
    case 'subagent':
      return {
        [`.claude/agents/${n}.md`]: [
          '---',
          `name: ${n}`,
          'description: Quando delegar a este subagente (o Claude usa esta frase para decidir).',
          'tools: Read, Grep, Glob',
          '---',
          '',
          'Você é um subagente especializado em ...',
          '',
          '## Como trabalhar',
          '- ...',
          '',
          '## O que devolver',
          '- Um resumo curto com ...',
          ''
        ].join('\n')
      }
    case 'command':
      return {
        [`.claude/commands/${n}.md`]: [
          '---',
          'description: O que o comando faz',
          'argument-hint: [argumentos]',
          '---',
          '',
          'Faça ... com: $ARGUMENTS',
          ''
        ].join('\n')
      }
    case 'settings':
      return {
        '.claude/settings.json': JSON.stringify({ permissions: { allow: [], deny: [] }, hooks: {} }, null, 2) + '\n'
      }
    case 'script':
      return {
        [`.claude/scripts/${n}`]: n.endsWith('.ps1')
          ? '# Script auxiliar usado por skills/hooks.\nparam()\n'
          : n.endsWith('.py')
            ? '"""Script auxiliar usado por skills/hooks."""\n'
            : '#!/usr/bin/env bash\n# Script auxiliar usado por skills/hooks.\nset -euo pipefail\n'
      }
  }
}

/** Always-on instruction files (loaded into every session's context). */
export const ALWAYS_ON_FILES = ['CLAUDE.md', '.claude/CLAUDE.md'] as const

export function alwaysOnChars(tree: HarnessTree): number {
  return ALWAYS_ON_FILES.reduce((n, f) => n + (tree[f]?.length ?? 0), 0)
}

/** Above this, the always-on text gets a cost warning in the UI. */
export const ALWAYS_ON_WARN_CHARS = 8000

// IPC contract of this feature (see src/shared/ipc.ts).
declare module '../ipc' {
  interface IpcInvokeContract {
    [HARNESS.read]: (dir: string) => HarnessState
    [HARNESS.writeFile]: (dir: string, rel: string, content: string) => void
    [HARNESS.deleteFile]: (dir: string, rel: string) => void
    [HARNESS.createFromTemplate]: (dir: string, kind: TemplateKind, name?: string) => string[]
    [HARNESS.snapshots]: (projectCwd: string) => HarnessSnapshot[]
    [HARNESS.snapshotCreate]: (projectCwd: string, label: string, dir?: string, note?: string) => HarnessSnapshot
    [HARNESS.snapshotRestore]: (projectCwd: string, id: string, dir?: string) => HarnessSnapshot
    [HARNESS.snapshotDelete]: (projectCwd: string, id: string) => void
    [HARNESS.diff]: (from: HarnessTree, to: HarnessTree) => TreeDiffFile[]
    [HARNESS.lessons]: (projectCwd: string) => Lesson[]
    [HARNESS.saveLesson]: (lesson: Lesson, reflectionId?: string) => Lesson
    [HARNESS.updateLesson]: (projectCwd: string, id: string, patch: LessonPatch) => Lesson
    [HARNESS.deleteLesson]: (projectCwd: string, id: string) => void
    [HARNESS.reflections]: (projectCwd: string) => Reflection[]
    [HARNESS.reflectSession]: (sessionId: string, opts?: ReflectSessionOptions) => ReflectProposal
  }

  interface IpcEventContract {
    [HARNESS.evChanged]: HarnessChange
  }
}
