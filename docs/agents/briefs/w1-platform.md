# M1 (plataforma): token do app nas rotas do membro e eventos SSE

Repositório `C:\Users\valteresj\OneDrive\Documentos\central_agents`, branch já criado **`feat/app-hangar-workspace`**
(empilhado sobre `feat/app-hangar-models`). **Não faça commit, push nem troque de branch.** Mesmo padrão de antes:
graphify antes de grep, pytest completo sem regressão, ruff limpo, i18n pt-BR/en.

Especificação: `docs/app-hangar-workspace.md` (cópia do contrato M1; siga à risca). Contexto geral:
`C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\docs\platform\portal-migration-plan.md`.

## Entregas

1. **Allowlist do token `app`**: dependência única para rotas do membro; aplicar só às rotas da lista da M1
   (`GET /api/me/workspace`, `GET /api/decisions`, `GET /api/org-chart?mine=1`, `GET /api/inbox`). Matriz de testes:
   cada rota da lista aceita o token `app` com o acesso da pessoa; uma amostra larga de rotas de admin/auditor/
   configuração/chaves/OAuth recusa; `org-chart` sem `mine=1` recusa o token `app`.
2. **`GET /api/app/events`** (SSE) com os tipos da M1, `id` crescente, `Last-Event-ID`, keepalive, filtragem pelo
   que a pessoa pode ver; emissão nos pontos certos (decisão criada/decidida, caixa de entrada, status de agente,
   lista de modelos). Funciona com várias réplicas; documente a escolha. Testes com o `TestClient` lendo o stream.
3. **Contrato, seção 4**: escreva em `docs/app-hangar-workspace.md` **e** em
   `C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\docs\platform\m1-contract.md` (a mesma seção nos dois) o
   formato de resposta de cada rota da lista, com exemplos reais tirados da instância de dev.
4. Docs em `docs/api.md`.

## Instância de desenvolvimento

Atualize a instância `http://localhost:8091` (`C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091`) para este
branch, mantendo os usuários de teste. Para o Início ter conteúdo, crie na instância (pela API/CLI do próprio repo,
só nela) um agente pessoal do `dev-membro` e um digital employee com uma decisão pendente — dados de teste.
**Não toque** no container `agent-hangar-central-1`, no Postgres dele, no `.env` nem no compose. Deixe a instância
rodando e documente.

Relatório: `C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\docs\agents\reports\w1-platform.md`.
Responda só `PRONTO: w1-platform`.
