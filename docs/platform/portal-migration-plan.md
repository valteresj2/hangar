# Plano: do portal `/app` para o Hangar Desktop (portal enxuto)

Objetivo: o **Hangar Desktop vira a vitrine do membro** (seus agentes, decisões, caixa de entrada, issues, trabalho),
o console `/ui` continua sendo do admin, e o **`/app` fica enxuto**: o que precisa existir na web (login,
consentimentos, aprovação rápida pelo celular, segurança da conta) e uma porta para o Desktop.

Levantamento feito no código de `central/app/static` (branch `feat/app-hangar-models`): `PORTAL_ROUTES` em `app.js`,
páginas em `member.js`, `employees.js`, `work.js`, `issues.js`, `analyst.js`, `org.js`.

## 1. Inventário das telas do `/app`

| Rota                    | Tela                                                                                                   | Função                       | APIs que usa                                                              | Destino                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `#/`                    | Início (primeiros passos, decidir, meus agentes, trabalhando agora, custo do mês, vistos recentemente) | `memberHome`                 | `/me/workspace`, `/decisions`                                             | **Desktop (M1)**                                           |
| `#/mine`                | Meus agentes                                                                                           | `myAgentsPage`               | `/me/workspace`, `/org-chart?mine=1`, `/employees/{slug}/promote-to-team` | **Desktop (M1)**                                           |
| `#/decisions`           | Decisões (aprovar/recusar, em lote)                                                                    | `decisionsPage`              | `/decisions`, `/decisions/batch`                                          | **Desktop (M2)** + **web essencial**                       |
| `#/inbox`               | Caixa de entrada (badge, marcar lida)                                                                  | `inboxPage`                  | `/inbox?view=`, `/inbox/mark` (polling 60 s)                              | **Desktop (M2)** + web essencial simplificada              |
| `#/tasks/{id}`          | Tarefa de um agente (cancelar, avaliar)                                                                | `taskPage`                   | `/tasks/{id}`, `/cancel`, `/quality`                                      | **Desktop (M2)** + web (alvo dos links)                    |
| `#/my-issues`           | Minhas issues                                                                                          | `issuesPage(true)`           | `/projects`, issues (polling)                                             | **Desktop (M3)**                                           |
| `#/work`, `#/work/{id}` | Meu trabalho / item de trabalho                                                                        | `myWorkPage`, `workItemPage` | `/work-items…`                                                            | **Desktop (M3)**                                           |
| `#/search`              | Busca                                                                                                  | `searchPage`                 | `/search?q=`                                                              | **Desktop (M3)** — na paleta Ctrl+K                        |
| `#/agents/{slug}`       | Detalhe de um agente (testar, publicar, parar)                                                         | `agentDetail`                | `/agents/{slug}`, `/test`, `/ship`, `/deploy`, `/stop`                    | **Desktop (M3)**                                           |
| `#/employees/{slug}`    | Digital employee (período de experiência, status)                                                      | `employeeDetail`             | `/employees/{slug}`, `/probation`, `/status`                              | **Desktop (M3)**                                           |
| `#/projects/{slug}`     | Projeto (metas, funcionários)                                                                          | `projectDetail`              | `/projects/{slug}`, `/goals`, `/employees`                                | **Desktop (M5)**, junto com o compartilhamento de projetos |
| `#/org`                 | Organograma                                                                                            | `orgVisualPage`              | `/org-chart`, `/employees/{slug}…`                                        | **Abrir no navegador** (M5 opcional)                       |
| `#/runs/{id}`           | Execução de playbook                                                                                   | `runPage`                    | `/playbook-runs/{id}`                                                     | **Abrir no navegador**                                     |
| `#/connect-ai`          | Conectar minha IA (Claude.ai, ChatGPT, Codex…)                                                         | `connectAiPage`              | `/connect`, `/keys`                                                       | **Web** (é sobre outros clientes) + link no Desktop        |
| `#/access`              | Meus acessos (sessões, código de ativação)                                                             | `myAccessPage`               | `/me/sessions…`, `/me/activation-code`                                    | **Web essencial** (segurança da conta)                     |
| `#/keys`                | Minhas chaves e apps conectados                                                                        | `keysPage`                   | `/keys`, `/me/oauth`                                                      | **Web essencial**                                          |
| `#/oauth`               | Consentimento OAuth (inclusive do próprio Desktop)                                                     | `oauthConsentPage`           | `/oauth/consent`                                                          | **Web obrigatória**                                        |
| `#/vscode`              | Login da extensão VS Code                                                                              | `vscodeAuthorizePage`        | `/auth/vscode/…`                                                          | **Web obrigatória**                                        |
| `#/login`               | Login (SSO/local)                                                                                      | —                            | `/auth/…`                                                                 | **Web obrigatória**                                        |

Links que a plataforma manda para o `/app` (Slack, Teams, e-mail, push): `#/decisions` (notify, webpush,
employee_tasks), `#/tasks` (notify, chat_tasks, employee_teamwork, employee_external), `#/employees`, `#/projects`,
`#/plugins`, `#/watchers`, `#/budgets`, `#/audit`. Esses links continuam válidos: no portal enxuto eles abrem a
tela web essencial ou oferecem "Abrir no Hangar Desktop".

## 2. Arquitetura

### 2.1 Autenticação nas rotas do membro

As telas usam rotas `/api/*` do membro, autenticadas por cookie. O token OAuth do app (escopo `app`) hoje só vale em
`/api/app/*`. Em vez de duplicar cada rota numa fachada, **uma lista explícita de rotas do membro passa a aceitar o
token `app`** (dependência única, por exemplo `member_route(allow_app=True)`), sempre com o acesso da própria pessoa.
Rotas de admin, de auditor e de configuração **nunca** aceitam o token do app. Uma matriz de testes cobre cada rota
da lista (aceita) e uma amostra das proibidas (recusa).

### 2.2 Tempo real e notificações

- `GET /api/app/events` (SSE, token `app`): `inbox.changed`, `decision.created/decided`, `task.status`,
  `agent.status`, `models.changed`. Substitui o polling de 60 s no Desktop.
- O Desktop mostra **notificações nativas** (decisão nova, tarefa que precisa de você) com ação "Abrir".
- O web push continua para quem usa o portal no celular. Para não notificar em dobro, a pessoa escolhe por
  dispositivo onde quer receber; com o Desktop aberto e conectado, o push web fica em silêncio.

### 2.3 Deep links

- O Desktop registra o protocolo `hangar://` (`app.setAsDefaultProtocolClient`), com instância única já existente:
  `hangar://open/decisions/{id}`, `hangar://open/tasks/{id}`, `hangar://open/agents/{slug}`…
- No portal enxuto, as rotas migradas mostram "Abrir no Hangar Desktop" (tenta o `hangar://`) e "Continuar na web".
  Preferência por pessoa: "Abrir links da plataforma no Desktop" (redireciona sozinho).

### 2.4 No Desktop

- Feature novo **`workspace`** (telas da plataforma), separado do `platform` (conexão, sincronização).
- Navegação: a sidebar ganha uma seção **Agent Hangar** com Início, Decisões (badge), Caixa de entrada (badge),
  Meus agentes, Minhas issues, Meu trabalho; as sessões do Claude Code continuam na mesma sidebar.
- Cache local só de leitura (última versão de cada lista) para abrir rápido e mostrar algo offline; ações exigem
  conexão. Tudo no tema da plataforma (já aplicado).
- Ponte com o Claude Code: no detalhe de um agente, "Abrir sessão com este agente" (cria uma sessão do Hangar com o
  harness do agente) — o diferencial que a web não tem.

### 2.5 Portal enxuto

- Política no `/ui` (App Hangar → Políticas): **"Portal web para membros: completo | essencial"**, padrão
  **completo** até a adoção do Desktop chegar ao ponto que o admin quiser (a aba mostra a adoção).
- No modo essencial o `/app` mantém: login/SSO, consentimento OAuth, VS Code, Minhas chaves, Meus acessos,
  Conectar minha IA, **Decisões** e **Caixa de entrada** simplificadas (pensadas para celular), detalhe de tarefa
  (alvo dos links) e uma página **Baixar o Hangar Desktop**. As outras rotas mostram "Abrir no Desktop".

## 3. Fases

| Fase                   | Plataforma                                                                                                                                                   | Desktop                                                                                                                                                  | Pronto quando                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **M1 — Fundação**      | Allowlist do token `app` nas rotas do membro (com matriz de testes); `GET /api/app/events` (SSE)                                                             | Feature `workspace`, seção Agent Hangar na sidebar, **Início** e **Meus agentes**, protocolo `hangar://`                                                 | Membro vê o Início e os agentes dele no Desktop; deep link abre a tela certa               |
| **M2 — Decisões**      | Eventos de decisão/tarefa/caixa de entrada; preferência de notificação por dispositivo                                                                       | **Decisões** (aprovar/recusar, em lote), **Caixa de entrada**, **Tarefa**; notificações nativas                                                          | Um digital employee real pede decisão e o membro aprova pelo Desktop sem abrir o navegador |
| **M3 — Trabalho**      | — (rotas já existem)                                                                                                                                         | **Minhas issues**, **Meu trabalho**, busca na paleta Ctrl+K, detalhe de **agente** e de **digital employee** com as ações que a alçada da pessoa permite | Paridade com o portal para o uso diário                                                    |
| **M4 — Portal enxuto** | Política "completo / essencial", páginas web essenciais otimizadas para celular, "Abrir no Desktop", "Baixar o Desktop", métrica de adoção na aba App Hangar | Preferência "abrir links no Desktop"                                                                                                                     | Com a política em "essencial", nenhum fluxo de membro depende do portal completo           |
| **M5 — Opcional**      | —                                                                                                                                                            | Organograma, Projetos (junto com o compartilhamento de projetos), execuções de playbook                                                                  | Conforme demanda                                                                           |

Cada fase entra com testes nos dois repositórios: pytest (autorização, eventos), unitários e e2e do Desktop contra a
plataforma falsa e o e2e opt-in contra a instância de desenvolvimento.

## 4. Pré-requisitos antes da M4 (antes de enxugar o portal em uma empresa)

- PRs #57 e #58 integrados e implantados (com backup do Postgres: migrações `0052` e `0053`).
- **Assinatura de código** do Desktop (o Windows bloqueia o executável sem assinatura) e **atualização automática**
  com o repositório público de releases.
- Build para **macOS** se houver membros em Mac.
- Decisões testadas com digital employees reais (M2).

## 5. Riscos

- **Aprovador sem Desktop** (celular, máquina gerenciada): mitigado pela web essencial e pela política por empresa.
- **Ampliar o alcance do token do app**: mitigado pela lista explícita, por "nunca admin" e pela matriz de testes.
- **Duas interfaces durante a transição**: a M4 só desliga telas web quando a política é trocada; o portal completo
  continua sendo o mesmo código até lá.
- **Notificação em dobro**: preferência por dispositivo (2.2).

## 6. Decisões do dono do produto

1. Política padrão para empresas novas: **completo** (recomendado) ou **essencial**.
2. Navegação do Desktop: seção Agent Hangar **na mesma sidebar** das sessões (recomendado) ou uma alternância
   "Sessões | Workspace".
3. Ações de agente no Desktop: **testar e parar** para o dono do agente (recomendado) ou também **publicar**
   (que já passa por aprovação de quatro olhos quando o time exige).
