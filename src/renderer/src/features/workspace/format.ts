// Labels (the portal's, in pt-BR) and formatting for the workspace screens.

type Tone = '' | 'go' | 'hold' | 'stop' | 'info'

/** Digital employee status → label and pill tone. */
export const EMPLOYEE_STATUS: Record<string, [string, Tone]> = {
  draft: ['Rascunho', ''],
  onboarding: ['Contratação', ''],
  probation: ['Em experiência', 'info'],
  active: ['Ativo', 'go'],
  paused: ['Pausado', 'hold'],
  offboarded: ['Desligado', 'stop']
}

/** Plain agent status → label and pill tone. */
export const AGENT_STATUS: Record<string, [string, Tone]> = {
  draft: ['Rascunho', ''],
  tested: ['Testado', 'info'],
  test_failed: ['Testes falharam', 'stop'],
  stage: ['Em stage', 'info'],
  production: ['Em produção', 'go']
}

export const TASK_STATUS: Record<string, [string, Tone]> = {
  draft: ['Rascunho', ''],
  new: ['Na fila', 'info'],
  in_progress: ['Trabalhando', 'info'],
  waiting_human: ['Aguardando decisão', 'hold'],
  waiting_task: ['Aguardando colega', 'info'],
  done: ['Concluída', 'go'],
  failed: ['Falhou', 'stop'],
  cancelled: ['Cancelada', ''],
  expired: ['Expirou', 'stop'],
  waiting_budget: ['Parada por orçamento', 'stop'],
  blocked: ['Esperando dependências', 'info'],
  in_review: ['Em revisão', 'hold'],
  on_hold: ['Pausada', '']
}

export const DECISION_KIND: Record<string, string> = {
  approval: 'aprovação',
  cross_review: 'revisor de outro fornecedor',
  question: 'pergunta',
  admission: 'admissão',
  notice: 'aviso',
  capability: 'capacidade',
  plan: 'plano',
  review: 'revisão',
  review_fields: 'conferência de campos',
  doc_change: 'alteração de documento',
  message: 'mensagem para fora',
  regression: 'regressão',
  learning: 'aprendizado',
  org_change: 'mudança na organização',
  promote_personal: 'promover agente pessoal'
}

export const LEVEL_LABEL: Record<string, string> = {
  intern: 'Estagiário',
  junior: 'Júnior',
  pleno: 'Pleno',
  senior: 'Sênior'
}

export const BUILT_WHY: Record<string, string> = {
  personal: 'pessoal',
  maintainer: 'você mantém o time',
  creator: 'você criou'
}

export function statusOf(map: Record<string, [string, Tone]>, status: string): { label: string; className: string } {
  const [label, tone] = map[status] ?? [status || '—', '']
  return { label, className: tone ? `pill pill-${tone}` : 'pill' }
}

export function usd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `US$ ${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value && Math.abs(value) < 0.01 ? 4 : 2
  })}`
}

export function count(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('pt-BR')
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias", then the date. */
export function ago(iso: string | number | undefined, now = Date.now()): string {
  if (iso === undefined) return ''
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`
  if (s < 7 * 86_400) {
    const d = Math.floor(s / 86_400)
    return `há ${d} ${d === 1 ? 'dia' : 'dias'}`
  }
  return new Date(t).toLocaleDateString('pt-BR')
}

/** A future date ("próxima execução"): the date and time. */
export function when(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export function greeting(hour = new Date().getHours()): string {
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase()
}

/** Badge text: nothing for 0 or unknown, 99+ above 99. */
export function badge(n: number | undefined): string {
  return !n ? '' : n > 99 ? '99+' : String(n)
}
