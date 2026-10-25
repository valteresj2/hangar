# Modelos sincronizados (plataforma): botão no console, API de modelos, chave do dispositivo e proxy de LLM

Repositório: `C:\Users\valteresj\OneDrive\Documentos\central_agents`, branch já criado **`feat/app-hangar-models`**
(empilhado sobre `feat/app-hangar-phase1`). **Não faça commit, push nem troque de branch.** Você é o mesmo agente da
Fase 1 — o padrão de trabalho é o mesmo (graphify antes de grep, pytest completo, ruff, i18n pt-BR/en).

Especificação: `docs/app-hangar-models.md` (siga à risca; dúvidas e mudanças vão em "Pedidos ao chief"). Leia também
`central/app/static/llm.js` (página Provedores de LLM), `services/llm.py`, `services/llm_models.py`,
`services/catalog.py` (teste de conexão Anthropic), `services/usage.py`, `services/budgets.py`, `crypto.py`/cofre,
`org.code_policy`, e o que você fez na Fase 1 (`services/app_hangar.py`, `routers/app_hangar.py`).

## Entregas

1. Migração: `LlmConnection.sync_desktop`, `desktop_hidden_models`; chave LLM do dispositivo em `AppDevice`
   (só hash + prefixo + data). Endpoint admin para ligar/desligar a sincronização e esconder/mostrar modelos (só admin,
   auditado), recusando com motivo claro quando o protocolo não é `anthropic` ou quando `code_policy=approved` exige
   `allow_code`.
2. Console: o botão **"Sincronizar modelos de token com o Hangar desktop"** no cartão e no detalhe da conexão, com a
   lista de modelos (mostrar/esconder no app) e o motivo quando estiver indisponível; resumo na aba App Hangar.
3. `GET /api/app/models` e `POST /api/app/devices/{device_id}/llm-key` (rotação; a anterior deixa de valer).
4. **Proxy** `/api/app/llm/{connection_id}/v1/messages` (streaming SSE sem buffer), `/v1/messages/count_tokens`,
   `/v1/models`: autenticação por `Authorization: Bearer ahl_…` ou `x-api-key: ahl_…`, credencial do cofre injetada,
   recusas (modelo escondido, conexão não sincronizada, regra de código, orçamento 429, dispositivo revogado 401),
   `UsageEvent` com tokens (inclusive dos eventos SSE `message_start`/`message_delta`) e custo, `client="hangar-desktop"`.
   Use `httpx` com streaming assíncrono; não guarde corpo nem resposta em log/auditoria.
5. Testes pytest: matriz de autorização, rotação da chave, revogação, orçamento, regra de código, contagem de tokens no
   streaming (com um upstream falso no próprio teste), migração do zero. Suíte completa sem regressão; ruff limpo.
6. Docs: `docs/app-hangar-models.md` → "Desenvolvimento"; nota em `docs/api.md`.

## Instância de desenvolvimento

A instância da Fase 1 (`http://localhost:8091`, `C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091`) precisa
rodar o código novo com a migração: pare e suba de novo a partir deste branch, mantendo os usuários de teste
(`dev-admin`/`dev-membro`). Para testar o proxy de ponta a ponta, crie nela uma conexão `anthropic` apontando para um
**upstream falso**: o servidor Anthropic falso do app em
`C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\tests\mock-anthropic\` (veja como subir no
`docs/agents/reports/wave7-qa.md` do app; rode-o numa porta livre) — **nunca use chaves reais nem conexões da instalação
em uso**. **Não toque** no container `agent-hangar-central-1`, no Postgres dele, no `.env` nem no compose. Deixe a
instância e o upstream falso rodando ao terminar e documente como subir/parar.

Relatório: `C:\Users\valteresj\OneDrive\Documentos\Harness\hangar\docs\agents\reports\m-platform.md`.
Responda só `PRONTO: m-platform`.
