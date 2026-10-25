// The member's data of the fake platform (docs/platform/m1-contract.md), shaped like the real routes:
// GET /api/me/workspace (central/app/services/workspace.py:home), GET /api/decisions
// (employee_tasks.pending_for → request_dict + `mine`) and GET /api/org-chart?mine=1 (org_chart.chart + card).

export function mockWorkspace(): Record<string, unknown> {
  return {
    llm_ready: true,
    workspace: 'Acme Ltda',
    to_decide: 1,
    agents: [
      {
        slug: 'analista-dados',
        name: 'Analista de Dados',
        title: 'Analista de BI',
        mission: 'Relatórios semanais',
        status: 'active',
        avatar_url: '/api/avatars/analista-dados.svg',
        autonomy_level: 'pleno',
        team: 3,
        manager: 'Ana Souza',
        owner: 'Ana Souza',
        backups: [],
        tasks: { done: 12, in_progress: 1 },
        open_decisions: 1,
        overdue_tasks: 0,
        cost_30d: 4.5,
        hired_at: '2026-09-01T12:00:00+00:00',
        shadow: false,
        created_at: '2026-08-30T12:00:00+00:00',
        runtime: 'hangar',
        can_manage: true,
        personal: true,
        working_on: { id: 501, title: 'Relatório de vendas de outubro' }
      },
      {
        slug: 'suporte-n1',
        name: 'Suporte N1',
        title: 'Atendimento de primeiro nível',
        mission: '',
        status: 'probation',
        autonomy_level: 'junior',
        team: 5,
        open_decisions: 0,
        overdue_tasks: 2,
        cost_30d: 1.25,
        created_at: '2026-10-01T12:00:00+00:00',
        runtime: 'hangar',
        can_manage: true,
        personal: false,
        working_on: null
      }
    ],
    built_agents: [
      {
        slug: 'resumo-diario',
        name: 'Resumo diário',
        objective: 'Resume os e-mails do dia',
        status: 'production',
        version: 3,
        kind: 'assistant',
        team: 'Dados',
        why: 'creator',
        personal: false,
        schedules: 1,
        next_run_at: '2026-10-26T09:00:00+00:00',
        cost_30d_usd: 0.42,
        avatar_url: '/api/avatars/resumo-diario.svg'
      }
    ],
    my_tasks: [
      {
        id: 501,
        title: 'Relatório de vendas de outubro',
        status: 'in_progress',
        created_at: '2026-10-25T10:00:00+00:00'
      },
      { id: 498, title: 'Limpar a planilha de leads', status: 'done', created_at: '2026-10-20T10:00:00+00:00' }
    ],
    month_cost_usd: 12.34,
    personal_spent_usd: 4.5,
    personal_cap_usd: 50,
    personal_allowed: true,
    personal_count: 1,
    personal_max: 3
  }
}

export function mockDecisions(): Record<string, unknown>[] {
  return [
    {
      id: 77,
      kind: 'approval',
      employee: 'analista-dados',
      employee_title: 'Analista de BI',
      employee_name: 'Analista de Dados',
      task: { id: 501, title: 'Relatório de vendas de outubro', requester: 'Ana Souza' },
      action_type: 'send_external',
      mode: 'approve',
      tool: 'send_email',
      question: 'Enviar o relatório para a diretoria?',
      status: 'open',
      created_at: '2026-10-25T11:00:00+00:00',
      mine: true
    },
    {
      id: 78,
      kind: 'notice',
      employee: 'suporte-n1',
      employee_title: 'Atendimento de primeiro nível',
      employee_name: 'Suporte N1',
      task: null,
      question: 'Fila do suporte normalizada',
      status: 'open',
      created_at: '2026-10-25T11:30:00+00:00',
      mine: false
    }
  ]
}

export function mockChart(): { nodes: Record<string, unknown>[]; agents: unknown[]; me: unknown } {
  return {
    nodes: [
      {
        slug: 'analista-dados',
        name: 'Analista de Dados',
        title: 'Analista de BI',
        status: 'active',
        level: 'pleno',
        team: 'dados',
        manager: 'Ana Souza',
        reports_to: null,
        model: 'claude-sonnet-4-5',
        connection: 'Anthropic Acme',
        harness: 'claude-code',
        specialists: [{ slug: 'sql-helper', name: 'SQL Helper', harness: 'hangar' }],
        personal: true,
        owner: 'Ana Souza',
        can_manage: true,
        working_on: { id: 501, title: 'Relatório de vendas de outubro' }
      },
      {
        slug: 'suporte-n1',
        name: 'Suporte N1',
        title: 'Atendimento de primeiro nível',
        status: 'probation',
        level: 'junior',
        team: 'plataforma',
        manager: 'Ana Souza',
        reports_to: null,
        model: 'claude-haiku-4-5',
        connection: 'Anthropic Acme',
        harness: 'hangar',
        specialists: [],
        personal: false,
        can_manage: true,
        working_on: null
      }
    ],
    agents: [],
    me: { name: 'Ana Souza', email: 'ana.souza@acme.example', avatar_url: '', role: 'Staff' }
  }
}
