# w1-platform — M1 (plataforma): token do app nas rotas do membro e eventos SSE

Repositório `C:\Users\valteresj\OneDrive\Documentos\central_agents`, branch `feat/app-hangar-workspace` (sem commit,
sem push, sem troca de branch). Especificação: `docs/app-hangar-workspace.md`. Só preenchi a seção 4 do contrato,
igual nos dois arquivos (`docs/app-hangar-workspace.md` e `Harness\hangar\docs\platform\m1-contract.md`, conferido com
`diff`). As seções 1 a 3 não mudaram.

## O que foi feito

### 1. Token `app` nas rotas do membro (allowlist)
- **Dependência única** `member_route(allow_app=True, when=…, why=…)` em `central/app/routers/deps.py`:
  - Sem token OAuth (sessão, chave pessoal, admin): não muda nada.
  - Com token OAuth: só passa com `allow_app`, escopo `app` e o `when` satisfeito. Senão, 403.
  - `query_flag("mine")` é o `when` do organograma. Aceita `1`, `true`, `yes` e `on`, como o FastAPI lê um bool.
- **Middleware** (`main._oauth_allowed` / `_app_route`):
  - Um token OAuth só chega a uma rota `/api` quando a rota que vai atender tem a marca. O middleware testa as rotas
    na mesma ordem do roteador e usa a primeira que casa.
  - Na dúvida, recusa: rota desconhecida, rota incluída com outro prefixo, `/api/app/admin`, `/gw`, `/scim`.
  - O FastAPI 0.141 inclui routers de forma preguiçosa, então `deps.api_routes()` percorre `original_router`.
- **Rotas marcadas** (exatamente a lista da M1):
  - `GET /api/me/workspace`
  - `GET /api/decisions`
  - `GET /api/org-chart`, que pelo app só aceita `mine=1`; sem ele, 403 com
    `"forbidden: pelo app Hangar, só o organograma da pessoa (mine=1)"`
  - `GET /api/inbox` (lista e contagem, todos os `view`)
- O acesso é sempre o da própria pessoa, porque o principal OAuth já é o usuário, com os times e papéis dele. Uma
  pessoa que é admin da empresa vê como admin nessas quatro rotas, e em nenhuma outra.

### 2. `GET /api/app/events` (SSE)
- Código: `central/app/services/app_events.py` (novo), com a rota em `routers/app_hangar.py`.
- Migração **`0054_app_events`**: tabela `app_events (id, org_id, kind, ref, user_id, data, created_at)`.
- **Formato:**
  - Cada mensagem tem `id:`, `event:` e `data:`. O stream começa com `retry: 5000`.
  - `: keepalive` sai depois de 25 s sem mensagens.
  - O stream fecha depois de 30 min; o cliente reconecta com `Last-Event-ID` (cabeçalho, ou `?last_event_id=`).
  - Sem `Last-Event-ID`, a primeira mensagem é `inbox.changed {unread}`. O `id` dela é o cursor atual.
- **Tipos e pontos de emissão:** um ouvinte `after_flush` cobre todos os caminhos de escrita, inclusive os laços em
  segundo plano.

  | Evento | Quando é emitido |
  | --- | --- |
  | `decision.created {id, title, agent}` | `HumanRequest` novo, menos `shadow` e `cross_review`, que não aparecem em Decisões |
  | `decision.decided {id}` | O status sai de `open` |
  | `inbox.changed {unread}` | Decisão nova, decidida ou escalada (muda o responsável); tarefa de Digital employee criada ou mudando `status`/`due_state`; `InboxState` lido ou arquivado (só para a pessoa) |
  | `agent.status {slug, status}` | Agente ou Digital employee criado ou mudando de status. O Digital employee informa o status do funcionário, o mesmo de `/api/me/workspace` |
  | `models.changed {version}` | Mudança relevante em `LlmConnection`, `LlmModel` (fora `last_seen`) ou `Organization.code_policy` |

- **Filtragem na entrega**, com o acesso atual da pessoa:
  - Decisões: `can_decide`, a mesma regra de `GET /api/decisions`.
  - Tarefas: quem pediu, ou o gestor, dono, substituto ou mantenedor do time.
  - `agent.status`: a relação de "Meus agentes" (pessoal, gerenciado, mantenedor do time, criador).
  - `models.changed`: só sai quando a `version` de `models_for_app` muda para aquela conexão.
  - Várias mudanças da caixa no mesmo lote viram um `inbox.changed` só.
- **Várias réplicas (a escolha):**
  - A tabela é escrita na mesma transação da mudança: rollback não deixa evento fantasma.
  - Cada stream consulta a tabela a cada 2 s a partir do cursor.
  - Uma linha com id menor que chega atrasada (transação mais longa) é revisitada nas últimas 200 linhas. Ela sai
    **sem `id:`**, para o cursor do cliente nunca voltar.
  - Retenção de 24 h. A limpeza roda ao abrir streams, no máximo a cada 10 min por processo.
  - O token é conferido de novo a cada 60 s: autorização encerrada fecha o stream.
  - Não precisa de infraestrutura nova (SQLite e Postgres).
- Credencial: precisa ser de uma pessoa. O token admin recebe 403, e um token só `mcp` é recusado pelo middleware.

### 3. Contrato, seção 4
- Formato de cada rota, com tabela de campos para o Início e exemplos **reais** da instância de dev:
  - `/api/me/workspace`, `/api/decisions`, `/api/org-chart?mine=1` e `/api/inbox`
  - as recusas
  - duas capturas do SSE: ao vivo e replay com `Last-Event-ID: 0`
- Escrita nos dois arquivos.

### 4. Docs
- `docs/api.md`:
  - escopos do OAuth
  - linha `GET /api/app/events` na tabela do app
  - subseções "Member routes with the app token" e "Events (`GET /api/app/events`)", com os tipos, quando saem e como
    funciona com réplicas.

### Testes
- `tests/test_app_workspace.py` (novo, 14 testes):
  - **Lista fechada:** só as 4 rotas têm a marca.
  - **Rotas da lista:** aceitam o token `app` e respondem igual à sessão do portal da mesma pessoa. O colega do mesmo
    time não vê a decisão nem o agente pessoal.
  - **`org-chart`:** sem `mine=1` (vazio, `mine=0`, `mine=false`, `team=`) recusa; `mine=1` e `mine=true` aceitam.
  - **Matriz de recusa** com 45 rotas, com a pessoa promovida a admin: admin, auditor, config, catálogo de LLM, App
    Hangar admin, chaves, segredos, sessões, OAuth, SSO, escritas do membro, busca, `/api/me`, `/scim` e `/gw`. O teste
    também confere que cada rota da amostra existe, para a recusa não vir de um 404.
  - **Escopo:** um token só `mcp` é recusado nas 4 rotas.
  - **SSE pelo `TestClient`** (com tempo de vida curto, o stream termina e é lido inteiro):
    - retrato e cursor, keepalive, retomada sem retrato
    - `decision.created` e `decision.decided` com ids crescentes, e o colega sem eles
    - `agent.status` e `inbox.changed` do lido, e o colega sem eles
    - `models.changed` com a mesma `version` de `/api/app/models`
    - **entrega ao vivo:** uma thread grava durante o stream
    - autorização revogada fecha o stream
    - eventos exigem pessoa e escopo `app`
    - linha some no rollback; linha atrasada sai sem `id:`
    - retenção
- Suíte completa: ver "Resultado da suíte" abaixo. `ruff check central tests` limpo. `graphify update .` rodado.

## Instância de desenvolvimento (`http://localhost:8091`)
- Pasta: `C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091`.
- Reiniciada com este branch. A migração `0054` foi aplicada na subida. Backup antes da migração:
  `hangar.db.bak-0053`.
- Usuários mantidos: `dev-admin` / `Hangar-Dev-2026!` (admin) e `dev-membro` / `Hangar-Dev-2026!`.
- **Dados de teste novos**, criados só pela API desta instância:
  - Time `operacoes-dev`, com `dev-membro` como developer e `dev-admin` como maintainer.
  - **Agente pessoal** do `dev-membro`: `assistente-da-semana` (Digital employee pessoal, conexão `mock-anthropic`,
    `claude-haiku-4-5`).
  - **Digital employee** do time: `renata-renovacoes` (gestor: `dev-membro`, `claude-sonnet-4-5`).
  - **Decisão pendente** #1 para o `dev-membro`: proposta de `reports_to`, criada pelo admin com
    `POST /api/employees/renata-renovacoes/propose-reports-to`.
  - Resultado: o Início do `dev-membro` tem `to_decide: 1`, dois agentes e três tarefas de experiência em rascunho, e a
    caixa tem 4 itens.
  - Os dois funcionários ficam em `onboarding`, porque sem Docker eles não rodam.
- Scripts de apoio (fora do repo):
  - Seed idempotente: `C:\Users\valteresj\AppData\Local\Temp\claude\C--Users-valteresj-OneDrive-Documentos-central-agents\2e4b564b-4da5-45ba-a404-1393c1e8bba2\scratchpad\seed_w1.py`.
  - Captura dos exemplos: `…\scratchpad\capture_w1.py` e `…\scratchpad\replay_w1.py`, no mesmo diretório.
- **Subir:**
  ```powershell
  Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091\start.ps1' -WindowStyle Hidden
  ```
  O upstream falso, se preciso, sobe com `start-mock.ps1` na mesma pasta (porta 8790).
- **Parar:**
  ```powershell
  Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'hangar-dev-8091\\(serve.py|start.ps1|start-mock.ps1)' -or $_.CommandLine -match 'mock-anthropic\\cli.ts' } | % { Stop-Process -Id $_.ProcessId -Force }
  ```
- Estado ao terminar: central rodando (launcher em `launcher.pid`) e upstream falso rodando (node em `mock.pid`).
- O container `agent-hangar-central-1`, o Postgres dele, o `.env` e o compose não foram tocados.

## Como testar
```powershell
cd C:\Users\valteresj\OneDrive\Documentos\central_agents
.venv\Scripts\python -m pytest tests/test_app_workspace.py -q
```
Contra a instância de dev:
1. Rode `capture_w1.py`. Ele faz o OAuth do app como `dev-membro`, chama as 4 rotas e as recusas, abre o SSE e marca e
   desmarca a decisão no portal no meio.
2. Ou use `curl -N -H "Authorization: Bearer <token app>" http://localhost:8091/api/app/events`.

## O que ficou faltando
- **Postgres:** os testes rodam em SQLite. O ouvinte `after_flush` insere pela mesma conexão, o que é padrão do
  SQLAlchemy, mas não foi exercitado contra Postgres com concorrência real.
- **Concorrência:** a janela das linhas atrasadas (200 ids) cobre o caso normal; uma rajada muito grande de eventos
  dentro de uma transação longa pode passar dela.
- **`task.status`:** citado no plano (2.2) mas não na lista da M1; não foi implementado. A tabela e o `data` estão
  prontos para a M2.
- **i18n:** não houve texto novo de interface no console. As mensagens de erro da API seguem em português, como no
  resto da plataforma.
- **`CHANGELOG`:** não mexi; fica com o chief.

## Pedidos ao chief
1. **Integração:** a M1 depende de `0053_app_hangar_models` (`feat/app-hangar-models`). Integre os PRs em ordem e faça
   backup do Postgres: 0052, 0053 e 0054.
2. **Proxy reverso:** em produção, o `/api/app/events` precisa de buffering desligado e de um timeout de leitura de pelo
   menos 60 s. A resposta já manda `X-Accel-Buffering: no` (nginx). O keepalive é de 25 s.
3. **Carga:** cada conexão faz um `SELECT` indexado a cada 2 s. Com muitos Desktops conectados, avaliar
   `LISTEN/NOTIFY` do Postgres como sinal para acordar os leitores, mantendo a tabela como fonte. A interface do
   serviço não muda.
4. **Desktop:**
   - Trate os eventos como avisos e refaça a lista correspondente.
   - Uma mensagem sem `id:` é válida; não mexa no cursor.
   - Ao receber 401 na reconexão, renove o token.
   - O erro do middleware vem em `{"error": …}`; o da rota, em `{"detail": …}`. Leia os dois.
5. **M2:** ampliar a lista é marcar a rota com `member_route(allow_app=True)` e atualizar o conjunto `M1` em
   `tests/test_app_workspace.py`. O teste falha de propósito se alguém marcar uma rota sem mudar o contrato.
6. **Dado de teste:** a pergunta da decisão #1 começa com "admin-token propõe…", porque foi criada com o token de
   admin da instância. É só cosmético.

## Riscos conhecidos
- **Admin pelo app:** uma pessoa admin da empresa vê, pelo app, o que vê no portal nessas quatro rotas: todas as
  decisões e itens de admin da caixa. Isso segue o contrato ("acesso da própria pessoa"), mas amplia o alcance de um
  token de desktop roubado de um admin. A mitigação é o escopo `app` revogável por dispositivo.
- **Escrita por flush:** o ouvinte roda em todo flush da aplicação. É barato (percorre `new`/`dirty`), mas qualquer erro
  ali derruba a transação de quem escreveu. Os testes da suíte inteira passaram com ele ativo.
- **Formato herdado:** as rotas da lista devolvem o formato do portal, que pode mudar junto com ele. A seção 4 lista os
  campos de que o Desktop pode depender.

## Resultado da suíte
- `pytest tests` completo: **638 passaram, 3 falharam**, de 641.
- As 3 falhas são de `tests/test_observability.py` e são de ambiente, as mesmas da Fase 1 e da m-platform:
  `prometheus_client` e `opentelemetry` não estão no `.venv` local. Não há regressão.
- Depois dos últimos ajustes, `test_app_workspace`, `test_app_hangar`, `test_app_hangar_models`, `test_schema_drift` e
  `test_migrations_ids` rodaram de novo: 49 passaram.
- `ruff check central tests`: limpo.
