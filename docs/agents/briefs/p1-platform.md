# Fase 1 (plataforma): OAuth do app, dispositivos, aba "App Hangar" e design tokens

Você trabalha no repositório da plataforma **Agent Hangar**: `C:\Users\valteresj\OneDrive\Documentos\central_agents`
(Python 3.12+ / FastAPI / SQLAlchemy / Alembic, console em `central/app/static/*.js`). Branch já criado:
`feat/app-hangar-phase1`. **Não faça commit, push, nem troque de branch** — o chief comita.

Leia primeiro: o contrato `docs/app-hangar.md` (é a especificação; siga à risca), `AGENTS.md`/`CLAUDE.md` do repo se
houver, `llms.txt`, `central/app/services/mcp_oauth.py`, `central/app/routers/oauth.py`, `central/app/auth.py`,
`central/app/routers/deps.py`, `central/app/services/vscode.py` (padrão de cliente pessoal), `central/app/models.py`,
`central/migrations/`, `central/app/static/member.js` (HUBS_CONSOLE), `style.css` e `tests/conftest.py`.
O repositório tem um grafo em `graphify-out/` — use `graphify query "<pergunta>"` para achar código antes de grep.

## Entregas

1. **OAuth**: loopback com porta livre (RFC 8252 §7.3); escopos `app` e `mcp` guardados no grant (migração Alembic);
   sem `scope` continua `mcp`; token `app` aceito em `/api/app/*` (não em `/api/app/admin/*`), token `mcp` no `/mcp`;
   `software_id`/`software_version` guardados no cliente; tela de consentimento descreve os escopos.
2. **`/api/app`**: `me`, `devices` (registro idempotente), `heartbeat`, `design-tokens`, e `/api/app/admin/*`
   (`overview`, `devices`, `revoke`), exatamente como no contrato, com auditoria. Modelo `AppDevice` + migração.
   Revogar o grant, desligar o usuário ou revogar o dispositivo deixam o dispositivo `revoked` e o heartbeat devolve
   `revoked`.
3. **Console**: hub "App Hangar" com as abas Visão geral e Dispositivos (admin), no mesmo estilo e i18n do console
   (`i18n.js`: pt-BR e en). Visão geral mostra a URL pública da plataforma para colar no app e o passo a passo.
4. **Design tokens**: `central/app/static/design-tokens.json` (claro, escuro, fontes, raios) e um teste que falha se
   `style.css` divergir do JSON.
5. **Testes pytest** para tudo acima (OAuth com porta livre e escopos, compatibilidade do `/mcp` sem escopo, rotas do
   app com token `app`, recusa de token `mcp` em `/api/app` e de token `app` no admin, dispositivos, revogação,
   migração aplicando do zero). Rode `.venv\Scripts\python -m pytest` completo antes de terminar: nada que já passava
   pode quebrar. `ruff` limpo nos arquivos tocados. Docs: `docs/app-hangar.md` (já existe; não mude o contrato — se
   precisar, escreva em "Pedidos ao chief") e uma nota em `docs/api.md`.

## Instância de desenvolvimento (obrigatório para testar de ponta a ponta)

**Nunca toque** no container `agent-hangar-central-1`, no Postgres dele, no `.env` nem no `docker compose` — é a
instalação em uso do usuário. Para testar, suba a central a partir do código numa **instância separada**: porta
**8091**, `PUBLIC_BASE_URL=http://localhost:8091`, `DATABASE_URL=sqlite:///<pasta temporária>/hangar.db`, login local
ligado, um admin de teste criado pela CLI/seed do próprio repo. Descubra o comando (Dockerfile/CLI/README) e
documente em `docs/app-hangar.md` → "Desenvolvimento" e no relatório. **Deixe essa instância rodando ao terminar**
(o agente do app vai usá-la) e informe usuário/senha de teste no relatório (credenciais só de teste, criadas por você).

Relatório: `C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\docs\agents\reports\p1-platform.md` (o que mudou,
como rodar a instância, testes, pedidos ao chief). Responda só `PRONTO: p1-platform`.
