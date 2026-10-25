# m-client — Modelos de token sincronizados (app)

Feature `platform` (o mesmo agente da Fase 1). Especificação: `docs/platform/app-api-models.md`.

## O que foi feito

### 1. Sincronização (`src/main/features/platform/`)

- **`catalog.ts`** (novo, sem Electron, com testes unitários):
  - **`parseModels`** valida `GET /api/app/models`:
    - descarta conexões sem id inteiro, sem modelos ou com `base_path` fora de `/api/app/llm/<id>` (a chave do dispositivo nunca vai para outro lugar);
    - remove modelos duplicados.
  - **`profileFor` / `profileModels`** montam o perfil gerenciado da conexão:
    - `name: "Plataforma · <conexão>"`, `baseUrl: <plataforma>/api/app/llm/<id>`;
    - modelos: o primeiro é o padrão e os outros vão em `extra`;
    - `opus`, `sonnet` e `haiku` apontam para um modelo visível da mesma família e, se não houver, para o padrão. Isso cobre o item 3(c) do relatório `m-platform`: o Claude Code usa esses aliases nas chamadas de segundo plano, e o proxy recusa com 400 qualquer modelo fora da lista.
  - **`planFallback`** decide o que acontece com as sessões quando um perfil some.
- **`models.ts`** (novo) cuida do momento da execução:
  - **`syncModels`** faz `GET /api/app/models` (404 = "plataforma sem suporte"):
    - gera a chave `ahl_…` em `POST /api/app/devices/{id}/llm-key` quando ainda não existe;
    - cria, atualiza ou remove os perfis gerenciados;
    - guarda o catálogo, sem segredos, em `hangar-data/platform/models.json`. Assim o seletor mostra nome, contexto e preço mesmo offline.
  - **Rotação da chave.** A cada sincronização, e quando uma rodada num perfil gerenciado termina com erro (evento `session:turn-ended`, no máximo uma vez por minuto), o app testa a chave com `GET <proxy>/v1/models`.
    - Um **401 → a chave é rotacionada uma vez**, e os processos do Claude Code nesses perfis reiniciam com a chave nova: na hora se estiverem parados, ou ao fim da rodada.
    - 403, 429 ou falha de rede não dizem nada sobre a chave e são ignorados.
  - **Erros:**
    - de login (`session_expired`, `revoked`) sobem para o controller, que desconecta como na Fase 1;
    - os outros mantêm os perfis atuais e aparecem em `PlatformState.models.error`.
  - **`dropModels`** roda em todo logout: desconectar, revogação, sessão expirada, modo off, troca de URL e início do app sem login.
  - **`chooseModel` / `setDefaultModel`**: veja a entrega 3.
- **`controller.ts`**:
  - `sync()`, que roda ao conectar, a cada 15 min e no `powerMonitor` resume, agora termina em `syncModels()`.
  - `dropLogin()` remove os perfis gerenciados.
  - `syncModelsNow()` atende o botão "Sincronizar agora".
  - `PlatformState.models` traz `status`, `version`, `syncedAt`, `error` e `connections` (com modelos, contexto e preço).
- **IPC novo** (`src/shared/features/platform.ts`, tipado no `IpcInvokeContract`):
  - `platform:syncModels`;
  - `platform:chooseModel (sessionId, {providerId, model})`;
  - `platform:setDefaultModel ({providerId, model})`;
  - tipos `PlatformModels`, `PlatformConnection`, `PlatformModel` e `ModelChoice`, e a função `managedProfileId(id)` → `platform-<id>`.

### 2. Perfis gerenciados (`src/main/features/settings/providers.ts`)

- **`syncManagedProviders(wanted, secret?)`** deixa os perfis gerenciados exatamente como pedido:
  - todos são `kind: 'gateway'`, `authStyle: 'bearer'`, `managedBy: 'platform'` e `platformConnectionId`;
  - os que saíram da lista são removidos com o segredo;
  - se o padrão estava entre eles, o padrão volta para a assinatura;
  - só faz broadcast quando algo mudou.
- **Segredo:** a chave do dispositivo é o segredo de cada perfil, gravado com a mesma rotina de antes (`encryptSecret`, extraída de `storeSecret`; o safeStorage/DPAPI continua o mesmo). Também entraram `managedProviders()` e `managedProviderSecret()`.
- **Somente leitura para o usuário:** `saveProvider`, `deleteProvider`, `setProviderSecret` e `clearProviderSecret` recusam perfis gerenciados com a mensagem "gerenciado pela plataforma". Definir como padrão continua permitido.
- **UI (Configurações → Provedores):** o perfil gerenciado mostra o selo "gerenciado pela plataforma" (o tooltip explica) e "N modelos de token". Sem Editar e sem Excluir. Testar e Definir como padrão continuam.
- **Configurações → Plataforma:** novo cartão "Modelos de token" com:
  - conexões e modelos (o tooltip mostra contexto e preço);
  - a última sincronização;
  - o botão **Sincronizar agora**;
  - o aviso "plataforma sem suporte" ou o erro, quando houver.
- **Fallback das sessões** (`planFallback` + `models.ts`):
  - Uma sessão no perfil removido vai para a **assinatura**. Se o modelo dela era um modelo de token, volta para o modelo padrão. A transcrição ganha um aviso: *"Os modelos de token de “X” não estão mais disponíveis (motivo). A sessão passou a usar a assinatura Claude…"*.
  - Uma sessão que só seguia o padrão removido muda explicitamente quando usava um modelo de token. Caso contrário, só reinicia o processo.
  - Antes, o processo do Claude Code é interrompido (se estiver ocupado) e fechado, e a próxima mensagem retoma a conversa.
  - Se o `defaultModel` era um modelo de token, volta para `opus`.

### 3. Seletor único de modelo

- **`ModelPicker`** (`src/renderer/src/features/platform/ModelPicker.tsx` + `models.ts`) é um único `<select>` com:
  - grupo **Assinatura**: Opus, Sonnet, Haiku, Fable;
  - um grupo **Modelos de token · <conexão>** por conexão, com nome, contexto e preço por 1M, por exemplo "Claude Haiku 4.5 · 200k · US$ 1 / 5 por 1M"; o tooltip traz o id e "entrada / saída; custo estimado";
  - grupo **Outros perfis**: os perfis do usuário, como "Nome · Modelo";
  - um item opcional "Outro modelo…", para digitar um id;
  - `lockProvider`, que durante uma rodada só deixa trocar o modelo dentro da mesma origem.
- **Onde ele aparece:**
  - **Composer**: substitui os seletores de Provedor e de Modelo e chama `platform:chooseModel`.
    - Na mesma origem, `setOptions({model})` aplica na hora, como antes.
    - Em outra origem com histórico, roda o mecanismo existente (`switchProvider`: encerra o runner, deixa a nota e a próxima mensagem retoma).
    - Numa sessão que nunca rodou, só grava.
  - **Nova sessão e Quick Entry**: criam a sessão com `model`. Quando a origem é diferente do padrão, chamam `platform:chooseModel` antes de `engine:send`, porque `CreateSessionInput` não tem `providerId` (veja os pedidos ao chief).
  - **Configurações → Geral → Padrões de novas sessões → Modelo**: o mesmo seletor grava `defaultProviderId` e `defaultModel` (`platform:setDefaultModel`).
- **Rodapé da conversa** (`ChatView`):
  - Mostra o modelo e a origem: "Assinatura", "Token · <conexão>" ou o nome do perfil.
  - Nos modelos de token, mostra o custo da rodada pelos preços da plataforma, como "US$ … (estimado)". O tooltip diz que o oficial é o da plataforma.
- **`useProviders` do engine** agora também escuta `settings:event:providersChanged`. Sem isso, o composer continuava mostrando um perfil gerenciado que já tinha sido removido.

### 4. Testes

- **`tests/unit/platform-models.test.ts`** (12 testes), cobrindo:
  - `parseModels` (validação e lixo);
  - o mapeamento dos aliases;
  - `profileFor`;
  - criação dos perfis gerenciados: a chave fica cifrada (nunca em claro no disco) e `resolveLaunch` gera `ANTHROPIC_BASE_URL` (proxy), `ANTHROPIC_AUTH_TOKEN` (chave) e os aliases;
  - a recusa de editar, excluir ou trocar o segredo;
  - atualização no lugar e rotação da chave;
  - remoção com a volta do padrão para a assinatura;
  - a recusa de assumir um perfil do usuário;
  - os três casos de `planFallback`.
- **`tests/mock-platform/server.ts`** ganhou:
  - `GET /api/app/models`, que só traz conexões `sync` com protocolo `anthropic`, só modelos de texto e só os não escondidos;
  - `POST /api/app/devices/{id}/llm-key`, que rotaciona e invalida a anterior;
  - o proxy `/api/app/llm/{id}/…`, que confere a chave (Bearer ou x-api-key), o dispositivo, a sincronização (403) e a lista de modelos (400), atende `/v1/models` e encaminha para o `upstream` com a credencial da conexão, devolvendo o SSE pedaço a pedaço;
  - controles `setSync`, `invalidateLlmKeys`, `connections` e `proxied`.
- **`tests/e2e/platform-models.spec.ts`** (2 testes):
  1. Sincroniza (a conexão OpenAI fica de fora) e confere:
     - o perfil gerenciado é somente leitura;
     - o cartão em Plataforma aparece;
     - o seletor do composer escolhe "Claude Haiku 4.5…".
     
     Depois:
     - **a resposta chega em streaming pelo proxy** (o teste vê a resposta parcial antes do fim);
     - o rodapé mostra "Token · Anthropic Acme" e "(estimado)";
     - o mock da Anthropic só recebe `Bearer mock-token`, a credencial que o proxy injeta;
     - quando a chave é invalidada, ela é rotacionada e a mensagem seguinte passa;
     - quando a sincronização é desligada na plataforma falsa, **o perfil some, a sessão cai para a assinatura com o aviso** e o seletor perde o grupo;
     - quando a sincronização volta e o app desconecta, o perfil some.
  2. Configurações → Geral define um modelo de token como padrão, e a nova sessão abre nele. Ao desconectar, o padrão volta para `subscription`/`opus`.

## Verificação

| Etapa | Resultado |
|---|---|
| `npm run format:check` | ok |
| `npm run lint` | 0 erros (110 avisos, todos pré-existentes; os arquivos desta missão não têm nenhum) |
| `npm run typecheck` e `npm run typecheck:tests` | ok |
| `npm test` | 126/126 |
| `npm run test:e2e` | 11 passaram, 2 pulados (os opt-in reais); `panels.spec.ts` também passa agora |

Também rodei `graphify update .`, e não ficou nenhum Electron órfão.

## Integração real (8091)

`tests/e2e/platform-real.spec.ts` ganhou o teste "synced token models, a turn through the LLM proxy, sync off falls back". Ele:
- liga a sincronização pela API do admin (`PATCH /api/catalog/llm/<conexão>/desktop`);
- faz login pela UI;
- escolhe um modelo de token no composer;
- recebe a resposta pelo proxy real, que encaminha para o upstream falso em 8790;
- desliga a sincronização e confere o fallback para a assinatura com o aviso;
- no `finally`, volta a ligar a sincronização e desconecta, deixando a instância como estava.

A conexão usada é escolhida por `HANGAR_PLATFORM_CONNECTION` (padrão `mock-anthropic`).

Rodou contra `http://localhost:8091` com `dev-admin` (credencial do relatório `m-platform.md`), e os 2 testes passaram:
- `models: ok, mock-anthropic(claude-haiku-4-5,claude-opus-4-5,claude-sonnet-4-5)`
- `answered through the proxy with "Claude Haiku (mock) · 200k · US$ 1 / 5 por 1M"`

A 8090 nunca foi usada.

## Como testar

- `npm test`
- `npx electron-vite build && npx playwright test tests/e2e/platform-models.spec.ts`
- Contra a instância real: `HANGAR_PLATFORM_URL=http://localhost:8091`, `HANGAR_PLATFORM_USER`, `HANGAR_PLATFORM_PASSWORD` (admin), e então `npx playwright test tests/e2e/platform-real.spec.ts`.
- Manual:
  1. Em Configurações → Plataforma, conecte e veja o cartão "Modelos de token".
  2. Abra uma sessão e escolha "Modelos de token · …" no seletor do composer.
  3. No console, desligue "Sincronizar modelos de token com o Hangar desktop" e clique em **Sincronizar agora**: o perfil some e a sessão ganha o aviso.

## O que ficou faltando

- O seletor do Quick Entry não tem teste e2e; ele usa o mesmo componente e o mesmo IPC da nova sessão.
- O cartão de agendamentos (Configurações → Agendamentos) ainda usa o campo de texto de modelo. Agendamentos rodam no provedor padrão, então seguem um modelo de token padrão, mas não escolhem a origem.
- O custo estimado conta todo o input pelo preço de entrada. A plataforma cobra o cache a 1,25x (escrita) e 0,1x (leitura), então a estimativa fica um pouco diferente; ela é marcada como "estimado".

## Pedidos ao chief

1. **`CreateSessionInput.providerId`** (`src/shared/features/sessions.ts` e `createSession` em `sessions/index.ts`): `providerId?: string`, gravado na sessão. Hoje a nova sessão e o Quick Entry criam a sessão e depois chamam `platform:chooseModel`; com o campo, bastaria uma chamada.
2. **API do engine para outros features.** `platform/models.ts` importa `runnerFor`, `existingRunner` e `switchProvider` de `engine/registry.ts`, que não estão no contrato (de `engine/api.ts` só usa `interrupt` e `closeSession`). Sugestão para `engine/api.ts`:
   - `switchSessionProvider(sessionId, providerId, opts?: { model?: string; note?: string })`;
   - `noteSession(sessionId, text)`;
   - `sessionBusy(sessionId): boolean`.
3. **Código que ficou sem uso:**
   - `MODEL_OPTIONS` em `src/renderer/src/features/sessions/util.ts`;
   - o IPC `engine:setProvider` não é mais chamado pelo renderer, mas foi mantido.
   
   Apagar ou manter fica a seu critério.
4. **Docs:** em `ARCHITECTURE.md` e `FEATURES.md`, acrescentar os perfis gerenciados (`managedBy: 'platform'`), o seletor único (`ModelPicker` em `features/platform`) e os 3 canais novos.
5. Nenhuma dependência nova.

## Riscos conhecidos

- **Uma chave para todos os perfis.** Todos os perfis gerenciados guardam a mesma chave do dispositivo (cifrada uma vez por perfil). Rotacionar troca a chave em todos e reinicia os processos do Claude Code nesses perfis.
- **Teste da chave.** A cada sincronização (15 min) o app chama uma vez `GET <proxy>/v1/models`, que não gera cobrança.
- **Plataforma fora do ar** (status `error`): os perfis e a chave continuam. As rodadas falham como erro do provedor, com o cartão de erro do engine, até a plataforma voltar.
- **Fallback.** Uma sessão que estava gerando quando o perfil sumiu é interrompida. A mensagem dela recebe o aviso, mas é preciso reenviá-la.
- **Ids dos perfis.** Os ids são determinísticos (`platform-<id da conexão>`), e só existe um login por vez, então trocar de plataforma remove os perfis antes. Se o usuário já tiver um perfil com esse id, a sincronização recusa sem sobrescrever.
