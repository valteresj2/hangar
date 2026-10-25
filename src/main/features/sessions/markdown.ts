// Transcript → Markdown for "Exportar como Markdown".

import type { Session } from '../../../shared/contracts'
import type { PermissionDecision, TranscriptEntry } from '../../../shared/features/engine'

const OUTPUT_MAX = 4000

/** Fenced block whose fence is longer than any backtick run inside the content. */
function fence(content: string, lang = ''): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${content}\n${f}`
}

function clip(text: string): string {
  return text.length > OUTPUT_MAX
    ? `${text.slice(0, OUTPUT_MAX)}\n… (${text.length - OUTPUT_MAX} caracteres omitidos)`
    : text
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

function details(summary: string, body: string): string[] {
  return [`<details><summary>${summary}</summary>`, '', body, '', '</details>', '']
}

const DECISIONS: Record<PermissionDecision, string> = {
  allow: 'permitido',
  allow_always: 'permitido sempre',
  deny: 'negado'
}

type Role = 'user' | 'assistant' | 'other'

export function transcriptToMarkdown(session: Session, entries: TranscriptEntry[]): string {
  const out: string[] = [`# ${session.title}`, '']
  out.push(`- Pasta: \`${session.worktree?.path ?? session.cwd}\``)
  if (session.worktree) out.push(`- Worktree: \`${session.worktree.branch}\` (de \`${session.worktree.baseCwd}\`)`)
  if (session.model) out.push(`- Modelo: ${session.model}`)
  out.push(`- Criada em: ${new Date(session.createdAt).toLocaleString('pt-BR')}`)
  out.push(`- Exportada em: ${new Date().toLocaleString('pt-BR')}`, '')

  let last: Role = 'other'
  const heading = (role: Role) => {
    if (role === last) return
    last = role
    if (role === 'user') out.push('## Você', '')
    else if (role === 'assistant') out.push('## Claude', '')
  }

  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        heading('user')
        out.push(e.text, '')
        if (e.attachments?.length) out.push(...e.attachments.map((a) => `- 📎 \`${a}\``), '')
        break
      case 'assistant':
        // Sub-agent chatter is noise in an export; keep only top-level replies.
        if (e.parentToolUseId || !e.text.trim()) break
        heading('assistant')
        out.push(e.text, '')
        break
      case 'thinking':
        if (!e.text.trim()) break
        heading('assistant')
        out.push(...details('Raciocínio', e.text))
        break
      case 'tool_use':
        if (e.parentToolUseId) break
        heading('assistant')
        out.push(`**Ferramenta:** \`${e.name}\``, '', fence(clip(JSON.stringify(e.input, null, 2)), 'json'), '')
        break
      case 'tool_result':
        if (!e.content.trim()) break
        out.push(...details(e.isError ? 'Erro da ferramenta' : 'Resultado', fence(clip(e.content))))
        break
      case 'permission_request':
        out.push(quote(`Permissão solicitada: \`${e.request.displayName ?? e.request.toolName}\``), '')
        break
      case 'permission_decision':
        out.push(quote(`Decisão: ${DECISIONS[e.decision] ?? e.decision}${e.message ? ` — ${e.message}` : ''}`), '')
        break
      case 'result': {
        const parts = [`${(e.durationMs / 1000).toFixed(1)} s`, `${e.inputTokens} → ${e.outputTokens} tokens`]
        if (e.costUsd) parts.push(`US$ ${e.costUsd.toFixed(4)}`)
        out.push(`_${e.isError ? 'Rodada com erro' : 'Rodada concluída'} · ${parts.join(' · ')}_`, '')
        last = 'other'
        break
      }
      case 'system':
        if (e.text.trim()) out.push(quote(e.text), '')
        break
      case 'error':
        out.push(quote(`**Erro:** ${e.message}`), '')
        break
    }
  }

  if (entries.length === 0) out.push('_Sem mensagens na transcrição._', '')
  return out.join('\n')
}
