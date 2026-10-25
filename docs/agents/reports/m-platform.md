# m-platform — Modelos de token sincronizados (plataforma)

Repositório `C:\Users\valteresj\OneDrive\Documentos\central_agents`, branch `feat/app-hangar-models` (sem commit,
sem push, sem troca de branch). Especificação: `docs/app-hangar-models.md` (o contrato não mudou; só acrescentei a
seção "Desenvolvimento" no fim).

## O que foi feito

### 1. Modelo de dados e endpoint do admin
- **Migração `0053_app_hangar_models`** (down_revision `0052_app_hangar`):
  - `llm_connections.sync_desktop` (bool, padrão false) e `desktop_hidden_models` (JSON, lista).
  - `app_devices.llm_key_hash` (só o sha256, índice único), `llm_key_prefix` (12 caracteres) e `llm_key_created_at`.
  - `usage_events`: `agent_id` passa a aceitar nulo (uso sem agente) e entram `team_id` (indexado), `device_id`,
    `connection_id`, `client`, `tokens_cache_read` e `tokens_cache_write`. O downgrade apaga as linhas sem agente antes
    de voltar o `NOT NULL`.
- **`PATCH /api/catalog/llm/{name}/desktop`** (só admin; auditado como `llm_connection.desktop`):
  - `{sync: true|false}` liga ou desliga a sincronização;
  - `{model_id, hidden: true|false}` esconde ou mostra um modelo no app.
  - Recusa com 400 e o motivo quando o protocolo não é `anthropic` ou quando `code_policy=approved` exige `allow_code`.
  - `GET /api/catalog` passa a trazer `id` e `desktop: {sync, reason, active, models, models_total, hidden}` em cada
    conexão.
- Regras em **`central/app/services/app_llm.py`** (novo).

### 2. Console
- **Provedores de LLM (`static/llm.js`):**
  - Cada conexão ganha o bloco **Hangar desktop**: estado (sincronizada / não sincronizada / "sincronizada, mas
    indisponível"), o botão **"Sincronizar modelos de token com o Hangar desktop"** (ou "Parar de sincronizar…"), o
    motivo em vermelho quando não pode (o botão fica desabilitado) e a lista dos modelos de texto com contexto, preço e
    "esconder do app" / "mostrar no app".
  - O cartão do provedor na página inicial mostra "Hangar desktop" quando tem uma conexão sincronizada.
- **App Hangar → Visão geral (`static/apphangar.js`):** cartão "Modelos sincronizados: N conexões, M modelos", com link
  para Provedores de LLM. `GET /api/app/admin/overview` ganhou `models_synced: {connections, models}`.
- **Inglês:** strings em `i18n.js`, inclusive dois padrões com números.

### 3. API do app
- **`GET /api/app/models`:** exatamente o formato do contrato. Traz só as conexões sincronizadas e permitidas (protocolo
  e política de código), e só os modelos de texto disponíveis e não escondidos, com o preço de `prices_for`. A
  `version` é o sha256[:12] da lista e muda quando a lista muda.
- **`POST /api/app/devices/{device_id}/llm-key`:** exige o token OAuth com escopo `app` da pessoa dona do dispositivo.
  - Gera `ahl_` + 43 caracteres. A chave anterior deixa de valer na hora.
  - Resposta `{key, prefix, created_at}`; auditado como `app.device.llm_key` ("criada" ou "trocada", só com o
    prefixo).
  - Dispositivo revogado: 403. Inexistente: 404.

### 4. Proxy `/api/app/llm/{connection_id}/…` (`central/app/routers/app_llm.py`, novo)
- **Rotas:** `POST /v1/messages` (JSON e SSE), `POST /v1/messages/count_tokens`, `GET /v1/models` e
  `GET /v1/models/{id}`. As duas de modelos são respondidas pela plataforma, sem chamar o provedor.
- **Autenticação:** `Authorization: Bearer ahl_…` ou `x-api-key: ahl_…`. O middleware deixa `/api/app/llm/` passar e
  a rota confere a chave. A cada chamada ela confere:
  - o dispositivo ativo;
  - a pessoa ativa;
  - a autorização OAuth do dispositivo.

  Se a autorização acabou, o dispositivo passa a revogado (`sistema:…`) e o proxy responde 401. Token OAuth `aho_`,
  token admin ou chave antiga: 401.
- **Credencial do cofre:** vai como `x-api-key`. Para conexões que não são a API oficial da Anthropic, vai também
  `Authorization: Bearer` (os gateways no formato Anthropic aceitam).
  - Seguem para o provedor: `anthropic-version` (padrão `2023-06-01`), `anthropic-beta` e a query string (o Claude Code
    chama `/v1/messages?beta=true`).
  - Não seguem: cookies e a chave `ahl_`.
  - A resposta volta sem `set-cookie` e sem os cabeçalhos hop-by-hop.
- **Streaming:** `httpx.AsyncClient` com `send(stream=True)` e `aiter_bytes`. Cada pedaço é repassado assim que chega,
  e as linhas `data:` de `message_start` e `message_delta` são lidas de passagem, mesmo quando uma linha chega cortada
  em dois pedaços. Timeout de leitura: 900 s. Corpo até 32 MB (o limite da API da Anthropic); acima disso, 413.
- **Recusas** (formato de erro da Anthropic `{"type":"error","error":{type,message}}`, mais `detail`):

  | Situação | Resposta |
  |---|---|
  | Chave inválida, trocada ou revogada; pessoa desligada; autorização encerrada | 401 `authentication_error` |
  | Conexão não sincronizada; protocolo ≠ anthropic; política de código | 403 `permission_error` |
  | Conexão inexistente nesta empresa | 404 |
  | Modelo escondido ou que não é de texto | 400 `invalid_request_error`, com a lista liberada |
  | Orçamento do time com `budget_enforce` estourado, ou política de orçamento com parada (empresa ou time) | 429 `rate_limit_error`, em português |
  | Provedor fora do ar | 502 `api_error` |
- **Uso:** um `UsageEvent` por `/v1/messages`, gravado ao fim do stream (background task):
  - `agent_id=None`, `env="app"`, `channel` e `client` = `"hangar-desktop"`, `protocol="anthropic"`;
  - pessoa, time, dispositivo, conexão e modelo;
  - tokens de entrada e saída, e de cache (escrita e leitura);
  - custo pelo preço do modelo pedido (`llm_models.prices_for`), com o cache a 1,25x (escrita) e 0,1x (leitura) do
    preço de entrada.

  Também vai para as métricas Prometheus com `agent="hangar-desktop"`. Nada do corpo nem da resposta vai para log ou
  auditoria. `count_tokens` e `/v1/models` não registram uso nem conferem orçamento.
- **Orçamento do time:** `org.month_spend` e `budgets.spent` (escopo time) passaram a somar o uso direto das pessoas do
  time (`usage_events.team_id`). `budgets.stopped()` ganhou `team_id` para o uso sem agente.

### 5. Testes
- **`tests/test_app_hangar_models.py`** (novo, 16 testes) usa um upstream falso no próprio teste
  (`httpx.MockTransport`, com SSE em pedaços de 37 bytes que cortam as linhas). Cobre:
  - botão: recusa por protocolo e por política de código, aprovação, esconder e mostrar, auditoria, só admin;
  - `/api/app/models`: só os sincronizados e visíveis, formato, `version` estável e que muda;
  - rotação da chave (a antiga dá 401, a nova vale; só o hash no banco; auditoria);
  - matriz de autorização (sem chave, `ahl_` desconhecida, token OAuth, token admin, x-api-key e Bearer, conexão não
    sincronizada, conexão inexistente, modelo escondido, embedding, corpo sem modelo, corpo não JSON) e o provedor só
    recebe as chamadas autorizadas;
  - credencial do cofre, cabeçalhos e query repassados, sem a chave `ahl_` nem o cookie;
  - `UsageEvent` com tokens de cache e custo exatos;
  - streaming repassado intacto, com os tokens de `message_start` e `message_delta`;
  - `count_tokens` sem uso;
  - revogação pelo admin, saída pelo app (login novo reativa o dispositivo, mas não a chave antiga) e pessoa desligada;
  - política de código no proxy e na lista;
  - `budget_enforce` (429 depois de estourar) e política de time com parada;
  - resumo na visão geral;
  - migração do zero com downgrade para `0052` e upgrade de novo.
- **Ruff limpo.** O resultado da suíte completa está no fim deste relatório.

### 6. Docs
- `docs/app-hangar-models.md`: seção **"Desenvolvimento"** (o que foi implementado, as decisões e como testar de ponta a
  ponta).
- `docs/api.md`: novas linhas na tabela `/api/app` e a subseção "Synced token models and the LLM proxy".
- `graphify update .` rodado.

## Verificação de ponta a ponta (instância de dev + upstream falso)

- **Fluxo do app** contra `http://localhost:8091`, com `dev-membro`: OAuth loopback → registro do dispositivo →
  `GET /api/app/models` → chave (gerada duas vezes; a primeira passa a 401) → `/v1/messages` em JSON e SSE →
  `count_tokens` → modelo fora da lista (400). As duas chamadas ficaram em `usage_events` com tokens e custo, e a
  auditoria mostra a chave criada e trocada só pelo prefixo.
- **Claude Code real (`~/.local/bin/claude.exe`) pelo proxy:** com `ANTHROPIC_BASE_URL=http://localhost:8091/api/app/llm/1`,
  `ANTHROPIC_AUTH_TOKEN=ahl_…`, `CLAUDE_CONFIG_DIR` isolado e `claude -p "[[script:text]] oi"`, a resposta veio do
  upstream falso (`subtype: success`). O CLI chamou `/v1/messages?beta=true`. O uso registrado (9616 tokens de entrada,
  31 de saída, US$ 0,029313) bate com o custo que o próprio Claude Code calculou.

## Instância de desenvolvimento (rodando)

- **Central:** `http://localhost:8091` (127.0.0.1 e ::1), no código deste branch, com a migração 0053 aplicada.
  - Pasta: `C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091`. Arquivos: `start.ps1`, `serve.py`,
    `central.log`, `launcher.pid`, e `hangar.db` (cópia de antes da migração: `hangar.db.bak-0052`).
  - Processos: o PowerShell em `launcher.pid` (5496) → `python serve.py` (3252 → 27112).
- **Upstream Anthropic falso:** `http://127.0.0.1:8790` (`tests/mock-anthropic/cli.ts` do app).
  - Arquivos: `start-mock.ps1` e o log em `mock-anthropic.log` (UTF-16, por causa do `*>` do PowerShell).
  - Processos: o PowerShell em `mock.pid` (16096) → `node` (35652).
- **Conexão na instância:**

  | Campo | Valor |
  |---|---|
  | id | 1 |
  | nome | `mock-anthropic` |
  | provider | `custom-anthropic` |
  | base_url | `http://127.0.0.1:8790` |
  | chave | `mock-token` (do mock; não é uma chave real) |
  | sincronizada | sim |
  | modelos | `claude-opus-4-5` (US$ 5/25), `claude-sonnet-4-5` (US$ 3/15), `claude-haiku-4-5` (US$ 1/5) |
- **Usuários de teste** (só desta instância): `dev-admin` / `Hangar-Dev-2026!` (admin) e `dev-membro` /
  `Hangar-Dev-2026!` (membro). Dispositivos de teste criados: "E2E-Modelos" e "E2E-ClaudeCode".
- **Subir:**
  ```powershell
  $d = "$env:TEMP\hangar-dev-8091"
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$d\start.ps1" -WindowStyle Hidden -PassThru |
    % { Set-Content "$d\launcher.pid" $_.Id }
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$d\start-mock.ps1" -WindowStyle Hidden -PassThru |
    % { Set-Content "$d\mock.pid" $_.Id }
  ```
- **Parar** (só estes processos, por PID e linha de comando):
  ```powershell
  $d = "$env:TEMP\hangar-dev-8091"
  Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*hangar-dev-8091\serve.py*' -or $_.CommandLine -like '*mock-anthropic/cli.ts*' } |
    % { Stop-Process -Id $_.ProcessId -Force }
  Stop-Process -Id (Get-Content "$d\launcher.pid"), (Get-Content "$d\mock.pid") -Force -ErrorAction SilentlyContinue
  ```
- Não toquei no `agent-hangar-central-1`, no Postgres dele, no `.env` nem no compose.

## O que ficou faltando

- O console não foi conferido visualmente num navegador. A sintaxe dos JS está ok e os dados do botão vêm testados pela
  API.
- A migração foi testada só no SQLite (do zero, e o downgrade/upgrade). Não rodei contra Postgres.
- `CHANGELOG.md` não foi alterado (quem decide a versão é o chief).

## Pedidos ao chief

1. **Time que paga:** o contrato diz "time", mas a pessoa pode ser de vários. Usei o primeiro time (menor id), como nos
   agentes pessoais. Se o app tiver de escolher, falta um campo (ex.: `x-hangar-team`) no contrato.
2. **`usage_events.agent_id` nulo:** o uso do app conta no orçamento do time e da empresa e aparece no total de "meu
   uso" da Home. Não aparece nos painéis por agente (que filtram por agente). Uma visão "uso do Hangar desktop" no
   console seria o próximo passo.
3. **Para o agente do app (feature `platform`):**
   - (a) Um 401 do proxy com o OAuth ainda válido significa chave trocada ou apagada: gere outra em `llm-key`.
   - (b) Depois de qualquer revogação e de um login novo, a chave antiga não volta (o hash é apagado na revogação).
   - (c) O Claude Code usa um modelo leve em segundo plano. Defina `ANTHROPIC_SMALL_FAST_MODEL` /
     `ANTHROPIC_DEFAULT_HAIKU_MODEL` (e os de opus/sonnet) com modelos **visíveis** da conexão; senão o proxy responde
     400.
   - (d) Os erros do proxy vêm no formato da Anthropic, com `detail` também.
4. **Formato dos erros do proxy:** escolhi o da Anthropic (é o que o Claude Code mostra), diferente do `{"detail"}` do
   resto de `/api/app`. Se o contrato quiser outro, é só ajustar `ProxyError.body()`.
5. **Credencial para gateways:** fora da API oficial, mando `x-api-key` e `Authorization: Bearer` com a mesma chave.
   Se algum gateway recusar os dois juntos, dá para pôr um campo "estilo de autenticação" na conexão.
6. **Auditoria:** por chamada fica só o `UsageEvent`. A auditoria registra a troca de chave e a mudança de
   sincronização, nunca o conteúdo.
7. **`GET /api/app/models`** aceita qualquer pessoa autenticada (não só o token OAuth `app`), como `/api/app/me`. É só
   leitura e serve para conferir pelo console.
8. **Política de código mudada depois:** a conexão continua com `sync_desktop=true`, mas some da lista e o proxy recusa;
   o console mostra "sincronizada, mas indisponível" com o motivo. Voltar a aprovar a reativa sem outro clique.
9. **Ambiente:** os mesmos 3 testes de `tests/test_observability.py` falham porque `prometheus_client` e
   `opentelemetry` não estão no `.venv` (é do ambiente, não do código; igual à Fase 1).

## Riscos conhecidos

- **Orçamento com cache curto** (30–60 s) e custo gravado ao fim de cada chamada: chamadas em paralelo podem passar um
  pouco do limite antes do 429.
- **Cliente que desconecta no meio do stream:** o uso registrado é o que já tinha passado. Se o provedor não mandou o
  `message_delta`, a saída conta como o valor parcial do `message_start`.
- **Preço:** sem preço (nem do modelo nem da conexão), o custo fica zero, como no resto da plataforma. Os multiplicadores
  de cache são os da Anthropic. Um gateway com outro preço de cache fica com custo aproximado.
- **Modelos no proxy:** o proxy confia na lista de modelos da conexão (atualizada de hora em hora). Um modelo novo do
  provedor só fica disponível depois da atualização ou do botão "Atualizar modelos".

## Suíte completa

`pytest` completo: **627 testes, 624 passaram, 3 falharam**. As 3 falhas são as de `tests/test_observability.py`:
faltam `prometheus_client` e `opentelemetry` no `.venv`, as mesmas da Fase 1. `ruff check central tests`: limpo.

Na primeira rodada, 5 testes de `tests/test_mcp_oauth.py` falharam por um efeito colateral do meu arquivo novo: cada
teste registrava um app OAuth, e o limite de registros por hora do mesmo endereço (30) estourava antes dos testes de
OAuth. Corrigi fazendo os testes novos reutilizarem um único registro.
