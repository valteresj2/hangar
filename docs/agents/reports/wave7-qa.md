# Relatório — wave7-qa (servidor Anthropic falso, testes e CI)

## Resultado

- `npm test` (Vitest): **7 arquivos, 91 testes, todos passando** (~0,3 s).
- `npm run test:e2e` (build + Playwright/Electron com o mock): **7 cenários, todos passando** (~1,5 min).
- `npm run typecheck` passa, e os testes também passam no `tsc` (`npx tsc --noEmit -p tests/tsconfig.json`).
- `.github/workflows/ci.yml`: YAML validado com `js-yaml`; estrutura conferida passo a passo.
- Nenhum cenário usa a assinatura ou chaves reais. Cada teste roda com `CLAUDE_CONFIG_DIR` temporário e um perfil gateway → mock com token falso. O teste de streaming confere que **toda** chamada `/v1/messages` chegou com `Bearer mock-token`.

## Arquivos (todos meus)

```
tests/package.json                  "type": "module" (Node roda os .ts do mock direto)
tests/tsconfig.json                 typecheck dos testes (aliases @shared/@renderer)
tests/mock-anthropic/server.ts      servidor HTTP (sem dependências)
tests/mock-anthropic/scripts.ts     roteiros determinísticos
tests/mock-anthropic/cli.ts         mock avulso: node tests/mock-anthropic/cli.ts [porta]
tests/unit/helpers/electron.ts      electron falso (app.getPath → dir temporário; safeStorage sync e async)
tests/unit/*.test.ts                motion, harness, providers, reflector, lab, engine, mock-anthropic
tests/e2e/fixtures.ts               fixtures Playwright (mock + Hangar isolado)
tests/e2e/chat.spec.ts              tela inicial, streaming, permissão → arquivo → Artifacts
tests/e2e/panels.spec.ts            Terminal, Motion, teste de conexão 401
tests/e2e/lab.spec.ts               rodada manual K=1 até seleção cega e limpeza
vitest.config.ts · playwright.config.ts · .github/workflows/ci.yml
```

## 1. Servidor Anthropic falso

- **Rotas:**
  - `POST /v1/messages`, em JSON ou SSE, com a sequência `message_start` → `ping` → `content_block_start/delta/stop` (texto com `text_delta`; `thinking` com `thinking_delta` + `signature_delta`; `tool_use` com `input_json_delta` em pedaços) → `message_delta` (`stop_reason`, `usage`) → `message_stop`. O formato foi conferido na documentação oficial (platform.claude.com/docs/en/api/messages-streaming).
  - `POST /v1/messages/count_tokens` e `GET /v1/models[/:id]`.
  - Qualquer outra rota responde 404 com corpo de erro no formato Anthropic e fica registrada em `mock.unknown`.
- **Roteiros por marca** no último turno humano (`[[script:nome chave=valor]]`). Marcas de turnos anteriores não se repetem.
  - `text`, com `repeat=N` para respostas longas;
  - `thinking`;
  - `write-file path=…` (pede `Write` e conclui depois do `tool_result`);
  - `shell` (usa `Bash`, ou `PowerShell` quando o CLI do Windows não oferece Bash);
  - `error-401`, `error-500`, `overloaded`.
  
  Por token: `mock-token-401` e `mock-token-500` falham em qualquer requisição. Prompts do seletor do Lab (com `<candidate id=…>` e um bloco ```choice```) recebem `<why>` + a escolha do primeiro candidato. `delay=ms` desacelera aquele stream.
- **Provado primeiro com o CLI puro** (`claude -p`, tanto o `~/.local/bin/claude.exe` 2.1.307 quanto o `claude.exe` empacotado no SDK, com `ANTHROPIC_BASE_URL` = mock e `CLAUDE_CONFIG_DIR` isolado): texto em streaming, thinking, o ciclo `Write` → `tool_result` → resposta final (arquivo criado), shell, `--output-format json` e 401. **O CLI não chamou nenhuma rota desconhecida.**
- **Ajustes que o CLI real exigiu:**
  1. O Claude Code atual manda mensagens `role: "system"` no meio da conversa (ambiente, lembretes). O `tool_result` não é a última mensagem, então o mock passou a juntar os resultados depois da última mensagem do assistente.
  2. No Windows a ferramenta de shell é `PowerShell`.
  3. O diretório de trabalho vem numa dessas mensagens de sistema ("Primary working directory: …"), e o mock o usa para montar o caminho absoluto do `Write`.

## 2. Testes unitários (Vitest, `electron` mockado)

| Arquivo | Cobre |
|---|---|
| `motion.test.ts` | `parseMotion` (exemplo do repo, JSON inválido, cenas vazias, tipo inválido, x/y faltando, padrões, fps limitado, ids/campos preservados), `totalDuration`, `sceneAt` (bordas, fim, negativo), `sceneStart`; `elementState` (fora de start/end, fade, slide de entrada e saída, keyframes, typewriter), `imageSources` |
| `harness.test.ts` | tabela de `isHarnessPath`/`componentOf` (inclui `..`, `/` inicial, `settings.local.json`, barras invertidas); `readHarness`/`writeHarness` num dir temporário: só a superfície muda (adiciona, atualiza, apaga, poda a pasta de skill vazia); arquivos não-harness, `node_modules`, binários e grandes ficam intactos; caminho fora da superfície é recusado antes de tocar em qualquer coisa |
| `providers.test.ts` | `resolveLaunch` para assinatura embutida, gateway bearer e x-api-key, anthropic (endpoint e mapeamento de modelos), assinatura do usuário (mantém `CLAUDE_CODE_OAUTH_TOKEN`), bedrock, vertex, foundry; `unset`; `settingsEnv` zerando o `ANTHROPIC_MODEL` vindo de um `~/.claude/settings.json` falso; `extraEnv` protegido e validado; fallback de perfil apagado; **segredo nunca aparece** em `listProviders`, `providersState` ou em nenhum arquivo do userData; `maskSecrets`; chave vazia ou multilinha |
| `reflector.test.ts` | `parseReflection`: `<edits>` com linhas simples e com marcadores, valores multilinha, `component: none` descartado, normalização de veredito; `<experience>` com confiança e justificativa; `NO_ENTRY`; experiência incompleta; bloco truncado; `treeDiffText` |
| `lab.test.ts` | `anonId`, `makeBlindMap`; **seletor** (`askClaude` com SDK falso): ```choice``` + `<why>`, id minúsculo na mesma linha, id inexistente, sem bloco, erro da execução; **estágio do proponente** (`runStage`): `KEEP_BASE` em `<notes>`, edição em `harness/` virando proposta, arquivo fora da superfície → nova tentativa → herança, skill sem frontmatter corrigida na 2ª tentativa, chamada que falha herda na hora, gancho `HANGAR_LAB_TEST_INSTRUCTION` chegando à missão |
| `engine.test.ts` | `fromAssistantContent`, `toolResultsFromUserContent`/`toolResultText` (imagem, truncamento), `promptTextFromUserContent`, `parseQuestions`, `writtenPath`, `isProviderFailure`, `maskSecrets` do engine, `isMotionPath`, `toCommandInfo` |
| `mock-anthropic.test.ts` | protocolo do mock: ordem dos eventos, montagem dos blocos (inclusive o `input` do `tool_use`), segundo passo após `tool_result`, PowerShell, sem replay, 401/500, seletor, `count_tokens`, `models`, 404 registrado |

Os parsers do Lab (`CHOICE`, `WHY`, `NOTES`) não são exportados, então são testados pelas próprias funções (`askClaude`/`runStage`) com o SDK trocado por um `query()` roteirizado. Não precisei mudar `src/`.

## 3. Testes de ponta a ponta (Playwright `_electron`, build em `out/`)

A fixture `hangar` cria um diretório raiz temporário com:
- `userData/` (`--user-data-dir`, com `settings.json` pré-gravado: onboarding concluído e `claudeExecutablePath` = `claude.exe` do SDK, o mesmo que a CI terá);
- `claude/` (`CLAUDE_CONFIG_DIR`);
- `work/`.

O ambiente é limpo de `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDECODE` etc. O perfil do mock é criado por IPC (`settings:providerSave` → `providerSetSecret` → `providerSetDefault`) com `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` e `DISABLE_AUTOUPDATER=1` nas variáveis extras. Diálogos de confirmação são aceitos automaticamente. Em caso de falha, a fixture salva **screenshot e trace** em `test-results/`. No fim, fecha o app e apaga o diretório temporário.

| Cenário | O que confere |
|---|---|
| Tela inicial | título, botão "Nova sessão", "Escolher pasta", busca |
| Streaming | sessão numa pasta temporária; resposta longa vista **parcial** e depois inteira; chamadas com `stream: true` e só com o token falso |
| Permissão | `[[script:write-file]]` em modo `default` → cartão "Claude quer usar…" → **Permitir** → arquivo escrito com o conteúdo do mock → resposta final → aparece em **Artifacts**, renderizado num `iframe sandbox="allow-scripts"` |
| Terminal | prompt do PowerShell na pasta da sessão; `echo hangar-e2e-ok` ecoa a saída |
| Motion | exemplo aberto pelo evento `OPEN_ARTIFACT_EVENT` (o mesmo caminho do "Abrir no player") → canvas, relógio `0:00.0 / 0:12.0`, marcadores de cena, ▶ avança o tempo, pixel de fundo `#faf9f5` |
| Lab (manual, K=1) | repo git temporário com commit; rodada criada por `lab:create` (UI aberta via Harness → "Abrir Lab"); as duas variantes rodam no mock e escrevem `resultado.md` nos worktrees; **seleção cega** com 2 candidatos sem rótulo e `blindMap` oculto; escolha + "Por quê?" → `decided` com o mapa revelado → **limpeza** remove os worktrees (`git worktree list` volta a 1) e o projeto continua intacto |
| Conexão 401 | perfil com `mock-token-401` → Configurações → Provedores → **Testar** → "✗ O provedor respondeu HTTP 401: credencial recusada — confira a chave/token…" sem o token no texto; o mock recebeu a chamada com aquele token |

**Achado sobre streaming:** o app transmite e renderiza deltas corretamente, mas em modo SDK o Claude Code repassa os `text_delta` **em rajadas**. Medi isso com o SDK puro: os deltas de uma resposta de 3 s chegam juntos, enquanto o `claude -p --include-partial-messages` os emite um a um. Por isso o teste usa uma resposta longa (`repeat=8`, 150 ms entre eventos), que dura várias rajadas, e espera um estado parcial antes do texto completo.

## 4. CI (`.github/workflows/ci.yml`)

`windows-latest`, Node 24 com cache de npm, `npm ci`, typecheck do app, typecheck dos testes, build, `npm test`, `npx playwright test` (reaproveita o build) e upload de `test-results/` + `playwright-report/` só em falha. Gatilhos: push na `main`, pull_request e manual. `permissions: contents: read`, `concurrency` cancela execuções antigas da mesma ref, sem segredos.

Não precisa de navegador do Playwright (usa o Electron) nem de rebuild do `node-pty` (vem com prebuilds win32-x64). O `claude.exe` do SDK está no `package-lock.json` como dependência opcional para win32-x64.

## Como rodar

```
npm test                         # unitários
npm run test:e2e                 # build + E2E (≈1,5 min; abre janelas do Electron)
npx playwright test -g Lab       # um cenário
MOCK_LOG=1 npx playwright test   # mostra as requisições que o mock recebe
node tests/mock-anthropic/cli.ts 8790   # mock avulso; depois:
#   ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_AUTH_TOKEN=mock-token claude -p "[[script:write-file path=a.txt]] crie"
```

## Pedidos ao chief

1. **`.gitignore`:** adicionar `test-results/` e `playwright-report/` (saídas do Playwright; apaguei as minhas, mas cada execução local as recria).
2. **(Opcional) `package.json`:** `"typecheck:tests": "tsc --noEmit -p tests/tsconfig.json"`. A CI já roda o comando direto.
3. **(Opcional) `vitest.config.ts`:** o Vite avisa "ESM syntax in a file loaded as CommonJS", porque o `package.json` da raiz não tem `"type": "module"`. É só aviso; renomear para `vitest.config.mts` o eliminaria, mas o nome do arquivo foi fixado no brief.

## Riscos / observações

- **Vazamento de contexto para o mock (só local):** com a pasta temporária dentro do perfil do usuário (`%TEMP%` fica em `C:\Users\<user>\…`), o CLI sobe os diretórios e carrega `C:\Users\<user>\.claude\CLAUDE.md` como CLAUDE.md "de projeto", mesmo com `CLAUDE_CONFIG_DIR` isolado. Isso só vai para o servidor falso local, não muda os roteiros e não acontece no runner da CI. Vale lembrar se alguém mirar o mock num gateway real.
- **Testes do `providers.ts`:** o agente de segurança está migrando o arquivo para o `safeStorage` assíncrono. O electron falso tem as duas APIs, e os testes aceitam `setProviderSecret` síncrono ou assíncrono (passam nas duas versões).
- **Tempos:** os E2E dependem do tempo de partida do `claude.exe` (2–10 s nesta máquina). Os timeouts são generosos e a CI tem 1 nova tentativa.
- Os E2E rodam com `workers: 1`: cada teste abre um Electron com userData próprio.
- Não foi possível executar o GitHub Actions daqui; o YAML foi validado por parser e por leitura.
