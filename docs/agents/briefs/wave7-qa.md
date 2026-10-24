# Sétima onda: qa (servidor Anthropic falso, testes e CI)

Regras de `docs/agents/RULES.md`. **Seu feature: `qa`.** Você é dono de: `tests/**`, `vitest.config.ts`,
`playwright.config.ts`, `.github/workflows/ci.yml` e `docs/agents/reports/wave7-qa.md`. Não altere `src/` (se um teste
precisar de um gancho no app, descreva em "Pedidos ao chief"). Não rode `npm install`: `vitest`, `@playwright/test`
(use `_electron` de `playwright`) já estão instalados; os scripts `test`, `test:e2e` existem no `package.json`.
Outros três agentes trabalham em paralelo (segurança, release, onboarding) — não toque nas pastas deles.

## 1. Servidor Anthropic falso (`tests/mock-anthropic/`)

Um servidor HTTP local (Node, sem dependências novas) que fala a **Messages API** o suficiente para o Claude Code:
`POST /v1/messages` com e sem `stream` (SSE: `message_start`, `content_block_start`/`delta`/`stop` para texto,
`thinking` e `tool_use` com `input_json_delta`, `message_delta` com `stop_reason`/usage, `message_stop`),
`POST /v1/messages/count_tokens`, `GET /v1/models`, e 404 controlado no resto (registre as rotas desconhecidas que o CLI
chamar). **Roteiros** determinísticos escolhidos por uma marca no último prompt do usuário (ex.: `[[script:write-file]]`):
responder texto; pedir `Write` de um arquivo e depois concluir após o `tool_result`; pedir uma ferramenta que exige
permissão; devolver 401/500. Confira o formato exato na documentação oficial da API (WebFetch
`https://docs.claude.com/en/api/messages-streaming`) e ajuste até o `claude` CLI real conversar com ele.
O app aponta para o mock com um **perfil de provedor gateway** (`baseUrl` = mock, token falso), criado via IPC
(`settings:providerSave`, `settings:providerSetSecret`, `settings:providerSetDefault`). Use também
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` nas variáveis extras do perfil se o CLI tentar falar com outros serviços.
Prove primeiro com o CLI puro: `claude -p` com `ANTHROPIC_BASE_URL` apontando para o mock.

## 2. Testes unitários (Vitest)

Funções puras e módulos do main com `electron` mockado (`vi.mock('electron', …)`): `parseMotion`/`totalDuration`/
`sceneAt` e `elementState` do runtime Motion; `isHarnessPath`/`componentOf`; `writeHarness`/`readHarness` num diretório
temporário (só a superfície de harness muda); `resolveLaunch` dos provedores (cada tipo, `unset`, `settingsEnv`,
`extraEnv` protegido, segredo nunca em texto); parsers do Lab (`choice`, `why`, `notes`/`KEEP_BASE`) e do refletor
(`<edits>`, `<experience>`, `NO_ENTRY`); conversões do engine que forem puras.

## 3. Testes de ponta a ponta (Playwright + Electron, com o mock)

`_electron.launch` com o build (`out/`), `--user-data-dir` temporário e o mock. Cenários: tela inicial; criar sessão
numa pasta temporária e receber texto em streaming; cartão de permissão → Permitir → arquivo escrito → aparece em
Artifacts; abrir Terminal e ver o prompt; Motion de exemplo (`docs/motion/example.motion.json`) toca no player;
rodada manual do Lab com K=1 num repo git temporário até a seleção cega e a limpeza; teste de conexão de um perfil com
o mock devolvendo 401. Nenhum cenário pode usar a assinatura real ou chaves reais.

## 4. CI (`.github/workflows/ci.yml`)

`windows-latest`, Node 24, `npm ci`, typecheck, build, testes unitários e e2e com o mock (artefatos de falha:
screenshots/traces). Sem segredos.

## Pronto quando

`npm test` e `npm run test:e2e` passam localmente; o YAML da CI é válido (confira com uma leitura cuidadosa — não há
como rodar o GitHub Actions daqui). Relatório em `docs/agents/reports/wave7-qa.md`; responda só `PRONTO: wave7-qa`.
