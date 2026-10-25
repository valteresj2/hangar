# Contrato M1 — Workspace no Hangar Desktop (Início, Meus agentes, eventos, deep links)

Parte do plano `docs/platform/portal-migration-plan.md` (cópia na plataforma: `docs/app-hangar-workspace.md`).
Decisões do dono do produto: política padrão do portal **completo**; seção **Agent Hangar na mesma sidebar** das
sessões; no Desktop o **dono pode testar e parar** agentes (M3). Mudanças neste contrato só pelo chief.

## 1. Token do app nas rotas do membro (plataforma)

- Uma dependência única marca as rotas do **membro** que aceitam o token OAuth com escopo `app`
  (ex.: `member_route(allow_app=True)`), sempre com o acesso da própria pessoa (times e papéis dela).
- **Lista da M1** (só leitura): `GET /api/me/workspace`, `GET /api/decisions`, `GET /api/org-chart` (apenas com
  `mine=1`), `GET /api/inbox` (lista e contagem). As fases seguintes ampliam a lista explicitamente.
- **Nunca** aceitam o token `app`: rotas de admin, auditor, configuração, chaves, segredos, OAuth/SSO, e qualquer
  rota fora da lista.
- O agente da plataforma documenta aqui, na seção 4, o formato da resposta de cada rota da lista (o que o Desktop
  pode ler), com exemplos.

## 2. Eventos (`GET /api/app/events`, SSE, Bearer `app`)

- `event: <tipo>` + `data: <json>`; `id:` crescente; o cliente reconecta com `Last-Event-ID`; comentário de
  keepalive a cada 25 s.
- Tipos da M1: `inbox.changed` `{unread}`, `decision.created` `{id, title, agent}`, `decision.decided` `{id}`,
  `agent.status` `{slug, status}`, `models.changed` `{version}`. Só eventos que a pessoa pode ver.
- Implementação simples e segura para várias réplicas (ex.: tabela/fila de eventos por pessoa com retenção curta,
  ou o barramento que a plataforma já tiver); documente a escolha.

## 3. Desktop

- Feature **`workspace`**: seção **Agent Hangar** na sidebar (acima das sessões; recolhível) com **Início** e
  **Meus agentes** (Decisões e Caixa de entrada aparecem com badge e abrem o portal no navegador até a M2).
- **Início**: cartões "Para você decidir", "Meus agentes", "Trabalhando agora", "Custo no mês", "Decisões" e
  "Vistos recentemente" (o equivalente nativo do Início do portal), com o tema da plataforma.
- **Meus agentes**: lista com status, tipo (agente / digital employee), último uso; detalhe abre o portal até a M3.
- Eventos SSE com reconexão (e fallback de polling de 60 s se o SSE cair); badges ao vivo.
- **Deep links `hangar://`**: `hangar://open/<rota>` (ex.: `hangar://open/workspace/home`,
  `hangar://open/workspace/agents`, `hangar://open/decisions/<id>` → abre o portal no navegador até a M2).
  Registro do protocolo em tempo de execução no main (Windows/Linux via `setAsDefaultProtocolClient` +
  `second-instance`, macOS via `open-url`) e, no instalador, a declaração do protocolo (`electron-builder.yml`,
  feita pelo agente release).
- Sem conexão com a plataforma: a seção mostra "Conecte à plataforma" (modo híbrido).

## 4. Respostas das rotas do membro (preenchido pelo agente da plataforma)

_(a preencher)_
