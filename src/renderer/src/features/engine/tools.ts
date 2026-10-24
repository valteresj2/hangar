// Display helpers for tool calls.
import type { TodoItem, TranscriptEntry } from '@shared/features/engine'

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const LABELS: Record<string, string> = {
  Bash: 'Bash',
  PowerShell: 'PowerShell',
  Read: 'Ler',
  Write: 'Escrever',
  Edit: 'Editar',
  MultiEdit: 'Editar',
  NotebookEdit: 'Editar notebook',
  Glob: 'Buscar arquivos',
  Grep: 'Buscar texto',
  WebFetch: 'Abrir página',
  WebSearch: 'Pesquisar na web',
  Agent: 'Agente',
  Task: 'Agente',
  TodoWrite: 'Tarefas',
  Skill: 'Skill',
  AskUserQuestion: 'Pergunta',
  ExitPlanMode: 'Plano',
  ToolSearch: 'Carregar ferramentas'
}

export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    return `${server} · ${tool ?? ''}`
  }
  return LABELS[name] ?? name
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join('/')}`
}

/** One-line summary of a tool call's input. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(name)) return str(input.description) ?? firstLine(str(input.command) ?? '')
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  if (path && name !== 'Grep' && name !== 'Glob') return shortPath(path)
  if (name === 'Grep' || name === 'Glob') return [str(input.pattern), path && `em ${shortPath(path)}`].filter(Boolean).join(' ')
  if (name === 'WebFetch') return str(input.url) ?? ''
  if (name === 'WebSearch') return str(input.query) ?? ''
  if (name === 'Agent' || name === 'Task') return str(input.description) ?? str(input.subagent_type) ?? ''
  if (name === 'TodoWrite') return `${Array.isArray(input.todos) ? input.todos.length : 0} tarefas`
  if (name === 'Skill') return str(input.skill) ?? ''
  for (const v of Object.values(input)) {
    const s = str(v)
    if (s) return firstLine(s)
  }
  return ''
}

function firstLine(s: string): string {
  const line = s.trim().split('\n')[0]
  return line.length > 140 ? `${line.slice(0, 137)}…` : line
}

/** Tools whose calls feed the pinned checklist instead of getting a card. */
export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * The current task list. Older CLIs send whole lists through TodoWrite; newer ones create and update
 * tasks one at a time (TaskCreate / TaskUpdate), whose ids appear in the TaskCreate result text.
 */
export function latestTodos(entries: TranscriptEntry[]): TodoItem[] | undefined {
  const results = new Map<string, string>()
  for (const e of entries) if (e.kind === 'tool_result' && !e.isError) results.set(e.toolUseId, e.content)

  let todoList: TodoItem[] | undefined
  const tasks = new Map<string, TodoItem>()
  let lastWasTasks = false
  for (const e of entries) {
    if (e.kind !== 'tool_use') continue
    const input = e.input
    if (e.name === 'TodoWrite' && Array.isArray(input.todos)) {
      todoList = input.todos as TodoItem[]
      lastWasTasks = false
    } else if (e.name === 'TaskCreate' && results.has(e.toolUseId)) {
      const id = /#?(\d+)/.exec(results.get(e.toolUseId) ?? '')?.[1] ?? String(tasks.size + 1)
      tasks.set(id, { content: str(input.subject) ?? '', activeForm: str(input.activeForm), status: 'pending' })
      lastWasTasks = true
    } else if (e.name === 'TaskUpdate' && typeof input.taskId === 'string') {
      const task = tasks.get(input.taskId)
      if (!task) continue
      if (input.status === 'deleted') tasks.delete(input.taskId)
      else {
        if (typeof input.status === 'string' && STATUSES.has(input.status)) task.status = input.status as TodoItem['status']
        task.content = str(input.subject) ?? task.content
        task.activeForm = str(input.activeForm) ?? task.activeForm
      }
      lastWasTasks = true
    }
  }
  return lastWasTasks ? [...tasks.values()] : todoList
}
