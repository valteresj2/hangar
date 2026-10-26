// Compatibility layer for non-Claude models (pure: shared by the engine, the model bench and the renderer).
//
// Claude Code speaks the Anthropic Messages API and is tuned for Claude. Behind an Anthropic-compatible gateway
// (LiteLLM, OpenRouter…) other models get requests shaped for Claude. This module decides when a model needs
// adapting and with which limits; the engine's local proxy (main/features/engine/compat/) applies it per request.
import type { ProviderCompat, ProviderKind, ProviderModels } from './providers'

export interface ModelTraits {
  /** The model id the traits were looked up for (provider prefix kept). */
  model: string
  /** Not a Claude model, or the profile forces adaptation: requests and options are adapted. */
  adapted: boolean
  contextWindow: number
  maxOutputTokens: number
  /** Thinking is sent as a token budget (the gateway maps it to the provider's reasoning setting). */
  reasoning: boolean
  /** Where the limits came from. */
  source: 'table' | 'profile' | 'default'
}

const CLAUDE_MODEL = /(^|[/:.@-])(claude|anthropic)|^(opus|sonnet|haiku|fable)(\[1m\])?$/i

export function isClaudeModel(model: string | undefined): boolean {
  return !!model && CLAUDE_MODEL.test(model.trim())
}

interface TableRow {
  match: RegExp
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
}

// Known families (vendor docs, 2026). The first match wins; ids are compared without a "provider/" prefix.
// Unknown models get DEFAULT_TRAITS; a profile can override every field (Configurações → Provedores).
const TABLE: TableRow[] = [
  { match: /^gpt-5/, contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  { match: /^gpt-4\.1/, contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false },
  { match: /^gpt-4o/, contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false },
  { match: /^gpt-oss/, contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true },
  { match: /^o\d/, contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true },
  { match: /^gemini-(2\.5|3)/, contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true },
  { match: /^gemini/, contextWindow: 1_048_576, maxOutputTokens: 8_192, reasoning: false },
  { match: /deepseek.*(reasoner|r1)/, contextWindow: 128_000, maxOutputTokens: 32_768, reasoning: true },
  { match: /deepseek/, contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false },
  { match: /qwen3?-coder/, contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: false },
  { match: /qwen3/, contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: false },
  { match: /qwen/, contextWindow: 32_768, maxOutputTokens: 8_192, reasoning: false },
  { match: /kimi|moonshot/, contextWindow: 262_144, maxOutputTokens: 16_384, reasoning: false },
  { match: /glm-4\.[5-9]|glm-[5-9]/, contextWindow: 200_000, maxOutputTokens: 32_768, reasoning: true },
  { match: /grok/, contextWindow: 256_000, maxOutputTokens: 32_768, reasoning: true },
  {
    match: /devstral|codestral|mistral-(large|medium)/,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    reasoning: false
  },
  { match: /mistral|mixtral/, contextWindow: 32_768, maxOutputTokens: 8_192, reasoning: false },
  { match: /llama-?4/, contextWindow: 1_048_576, maxOutputTokens: 16_384, reasoning: false },
  { match: /llama/, contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false }
]

export const DEFAULT_TRAITS = { contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false }

/** Claude Code refuses windows under 100k (it would compact on every turn); smaller models get this floor. */
export const MIN_CONTEXT_WINDOW = 100_000

const stripProvider = (model: string) => model.trim().toLowerCase().split('/').pop() ?? ''

/** Resolves an alias the composer uses ("sonnet", "opus[1m]"…) through the profile's model mapping. */
export function resolveModelAlias(model: string | undefined, models: ProviderModels | undefined): string | undefined {
  const m = model?.trim()
  if (!m) return models?.default ?? models?.sonnet
  const alias = m.replace(/\[1m\]$/i, '').toLowerCase()
  if (alias === 'opus' || alias === 'sonnet' || alias === 'haiku') return models?.[alias] ?? m
  return m
}

/** Whether a launch through a profile of `kind` can be adapted at all (only gateways reach non-Claude models). */
export function compatApplies(kind: ProviderKind | undefined, compat: ProviderCompat | undefined): boolean {
  return kind === 'gateway' && compat?.mode !== 'off'
}

export function modelTraits(model: string, compat?: ProviderCompat): ModelTraits {
  const id = stripProvider(model)
  const row = TABLE.find((r) => r.match.test(id))
  const adapted = compat?.mode === 'off' ? false : compat?.mode === 'on' || !isClaudeModel(model)
  const fromProfile = compat?.contextWindow || compat?.maxOutputTokens || compat?.reasoning !== undefined
  const base = row ?? DEFAULT_TRAITS
  return {
    model,
    adapted,
    contextWindow: Math.max(MIN_CONTEXT_WINDOW, compat?.contextWindow || base.contextWindow),
    maxOutputTokens: compat?.maxOutputTokens || base.maxOutputTokens,
    reasoning: compat?.reasoning ?? base.reasoning,
    source: fromProfile ? 'profile' : row ? 'table' : 'default'
  }
}

// ---- Tools ----

/**
 * The toolset adapted models get: Claude Code's file, shell and search tools, the todo list and questions.
 * Subagents, worktrees, cron, notebooks, skills and the deferred-tool search are left out: weaker tool callers
 * spend turns on them, and every tool definition costs context on each request (≈ 2.5k tokens per tool).
 * WebSearch is a server tool only the Anthropic API runs.
 */
export const CORE_TOOLS = [
  'Bash',
  'PowerShell',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'WebFetch',
  'AskUserQuestion'
]

/** Names other agent harnesses use for the same tools (lowercase), mapped back by the proxy. */
export const TOOL_NAME_ALIASES: Record<string, string[]> = {
  Bash: ['bash', 'shell', 'sh', 'run_shell_command', 'execute_command', 'run_command', 'terminal', 'exec'],
  PowerShell: ['powershell', 'pwsh', 'shell', 'run_shell_command', 'execute_command', 'run_command', 'terminal'],
  Read: ['read', 'read_file', 'view', 'view_file', 'cat', 'open_file', 'readfile'],
  Write: ['write', 'write_file', 'create_file', 'write_to_file', 'save_file', 'writefile'],
  Edit: ['edit', 'edit_file', 'str_replace', 'str_replace_editor', 'replace_in_file', 'apply_edit', 'replace'],
  Glob: ['glob', 'list_files', 'find_files', 'file_search', 'ls'],
  Grep: ['grep', 'search', 'search_files', 'grep_search', 'ripgrep', 'rg'],
  TodoWrite: ['todowrite', 'todo_write', 'update_todos', 'todo']
}

/** Argument names other harnesses use, by Claude Code's name (compared after lowercasing and dropping _ and -). */
export const ARG_SYNONYMS: Record<string, string[]> = {
  file_path: ['path', 'filepath', 'file', 'filename', 'target_file', 'absolute_path'],
  old_string: ['old_str', 'old', 'search', 'find', 'old_text', 'original'],
  new_string: ['new_str', 'new', 'replace', 'replacement', 'new_text', 'updated'],
  content: ['text', 'contents', 'data', 'file_text', 'body', 'code'],
  command: ['cmd', 'script', 'shell_command', 'commandline'],
  pattern: ['query', 'regex', 'glob', 'search', 'expression'],
  path: ['dir', 'directory', 'folder', 'cwd', 'root'],
  url: ['link', 'uri', 'href'],
  prompt: ['question', 'instruction', 'task']
}

// ---- Instructions ----

/**
 * Appended to Claude Code's system prompt for adapted models. Short on purpose: it restates the habits Claude has
 * from training that other models miss most often (measured by the model bench, docs/COMPAT.md).
 */
export function compatInstructions(opts: { shell: 'bash' | 'powershell' }): string {
  const shellTool = opts.shell === 'powershell' ? 'PowerShell' : 'Bash'
  return [
    '# Working with tools',
    '- Act through real tool calls (function calling). Never write a tool call as JSON, XML or code in your reply text, and never claim to have run, created or changed something you did not do through a tool.',
    `- Run commands with the ${shellTool} tool${opts.shell === 'powershell' ? ' (Windows PowerShell syntax: `;` instead of `&&`, `Get-Content`, `Select-String`)' : ''}. Use Read/Write/Edit for files and Glob/Grep to find them instead of shell equivalents.`,
    '- Read a file before you Edit it. `old_string` must be copied exactly from the file (same whitespace and indentation) and be unique; prefer a few exact lines over a whole block. Use Write to create a new file (Edit only changes files that exist) or to replace one whole.',
    '- Pass absolute paths. Send arguments exactly as each tool schema names them.',
    '- Grep runs ripgrep (Rust regex): no look-ahead/look-behind or backreferences. Use \\b, character classes or a second search instead.',
    '- When a tool returns an error, read it and fix the call; do not repeat the same failing call.',
    '- Get numbers and facts from tool output (count with Grep or the shell, run the program), never by estimating.',
    '- A bug report or failing test can hide more than one problem. After each fix, run the tests or the program again and read the output; keep fixing until it passes. Never report success the output does not show.',
    '- Finish with a short summary of what you changed and how you checked it.'
  ].join('\n')
}
