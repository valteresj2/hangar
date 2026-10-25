# Relatório — p1-platform (Fase 1, plataforma Agent Hangar)

Repositório: `C:\Users\valteresj\OneDrive\Documentos\central_agents`, branch `feat/app-hangar-phase1` (sem commit,
sem push, sem troca de branch). Contrato seguido: `docs/app-hangar.md` (só ganhou a seção **Desenvolvimento** no fim).

## O que mudou

### 1. OAuth (`central/app/services/mcp_oauth.py`, `routers/oauth.py`, `auth.py`, `main.py`)
- **Loopback com porta livre (RFC 8252 §7.3)**: `redirect_matches()` — para `127.0.0.1`, `[::1]` e `localhost`, a porta
  é ignorada; esquema, host, caminho e query continuam exatos. Fora do loopback, comparação exata como antes. A troca
  do código exige o mesmo `redirect_uri` (com a porta) do pedido.
- **Escopos `app` e `mcp`**: `oauth_grants.scope` guarda os escopos concedidos; `oauth_clients.scope` guarda os que o
  app declarou no registro. Pedido sem `scope` → `mcp` (Claude.ai/ChatGPT intactos). Valores desconhecidos são
  ignorados. O servidor concede a interseção entre o pedido e o registrado (RFC 6749 §3.3); interseção vazia →
  `invalid_scope` (devolvido ao app pelo redirect). O refresh mantém os escopos; a resposta do token traz `scope`.
- Metadados: `scopes_supported` do servidor de autorização = `["app","mcp"]`; o do recurso `/mcp` continua `["mcp"]`.
- **Middleware**: token OAuth com `mcp` vale em `/mcp`; com `app` vale em `/api/app/*` menos `/api/app/admin/*`;
  qualquer outra rota → 403. `Principal` ganhou `grant_id` e `oauth_scopes`. Recusas do middleware em `/api/app/*`
  saem como `{"detail": …}` (o contrato pede esse formato).
- `software_id`/`software_version` guardados no cliente, no audit `oauth.register` e na lista de apps registrados do
  admin (`/api/oauth/clients` e a tabela em Chaves de API).
- **Consentimento** (`static/org.js`): mostra o software (`hangar-desktop 0.1.0`) e a lista de escopos com o que cada um
  permite (textos em `SCOPE_INFO`, traduzidos no `i18n.js`).
- Auditoria `app.login` na troca de código que concede `app`.

### 2. `/api/app` (`services/app_hangar.py`, `routers/app_hangar.py`) e modelo
- `GET /api/app/me`, `POST /api/app/devices` (idempotente por usuário + `device_id`), `POST
  /api/app/devices/{device_id}/heartbeat`, `GET /api/app/design-tokens`; admin: `GET /api/app/admin/overview`,
  `GET /api/app/admin/devices`, `POST /api/app/admin/devices/{id}/revoke` (`require_admin`) — formatos do contrato.
- Modelo `AppDevice` (OrgScoped) + migração `0052_app_hangar` (também cria as colunas de escopo e software).
- Auditoria: `app.device.register` (novo ou reconectado), `app.device.revoke`, `app.login`.
- **Revogação**:
  - admin revoga → dispositivo `revoked` (revogado_por = admin) + grant revogado; o mesmo `device_id` **não** volta a se
    registrar para aquela pessoa (403 `dispositivo revogado pelo administrador…`);
  - grant revogado (saída do app via `/oauth/revoke`, "Minhas chaves", app bloqueado, refresh expirado) ou pessoa
    desligada/SCIM inativo → dispositivo `revoked` com `revoked_by = "sistema:<motivo>"`; um login novo reativa;
  - `auth.revoke_user_sessions` já marca os dispositivos; as listas/heartbeat sincronizam os demais casos.
  - **Heartbeat devolve `revoked`** inclusive com o token de uma autorização encerrada: o middleware deixa passar só essa
    rota para tokens `aho_` inválidos; a rota confere o hash no banco e responde `{"status":"revoked"}` (grant revogado,
    app bloqueado, usuário inativo) ou 401 (token desconhecido ou só expirado → o app faz refresh).
- `/api/app/me` também atende a sessão do portal (só leitura); registrar dispositivo exige o token OAuth `app`.

### 3. Console (`static/apphangar.js`, `member.js`, `app.js`, `index.html`, `icons.js`, `i18n.js`)
- Hub `{ id: 'app', tabs: [['app','Visão geral','admin'], ['app/devices','Dispositivos','admin']] }` em `HUBS_CONSOLE`,
  item "App Hangar" (ícone `monitor`) no grupo Gestão, só para admin.
- Visão geral: números (ativos, membros, versões, último sinal), **URL pública da plataforma com copiar**, passo a passo
  de conexão e a política do Windows (`HKLM\Software\Policies\Hangar`, `PlatformUrl`, `Mode`); versões em uso.
- Dispositivos: tabela (pessoa, computador, app/canal, status com motivo, registrado, último sinal), filtro, "mostrar
  revogados" e **Revogar** com confirmação.
- pt-BR e en (todas as strings novas no `i18n.js`).

### 4. Design tokens
- `central/app/static/design-tokens.json`: `light` e `dark` (paleta completa; nomes = variáveis CSS sem `--`), `fonts`
  (`ui`, `sign`, `mono`, com `var(--f-ui)` resolvido) e `radius` (`r`, `r_lg`). Servido em `/api/app/design-tokens`
  com `version` = 12 primeiros hex do sha256 do conteúdo (muda sozinho a cada alteração).
- Teste `test_style_css_matches_design_tokens_json` falha se `style.css` (`:root` e o bloco escuro) divergir do JSON.

### 5. Testes e docs
- `tests/test_app_hangar.py` (17 testes): loopback com porta livre (unidade + fluxo), registro com escopo/software,
  consentimento com escopos, sem escopo = `mcp` e `/mcp` compatível, cliente antigo pedindo `app`, token `mcp` recusado
  em `/api/app`, token `app` recusado no `/mcp` e no admin (mesmo com usuário admin), `/me` e design tokens, registro
  idempotente/heartbeat/admin/overview/auditoria, sessão não registra dispositivo, revogação pelo admin, saída do app e
  re-login, revogação pelo portal, desligamento, 401 para token desconhecido/expirado, CSS × JSON, migração do zero
  (upgrade head, downgrade para 0051, upgrade de novo).
- `tests/test_ui_globals.py`: inclui `apphangar.js` na checagem de globais repetidos.
- `docs/api.md`: escopos no OAuth e a seção "Hangar desktop app (`/api/app`)". `docs/app-hangar.md`: seção
  **Desenvolvimento**.
- `ruff` limpo nos arquivos Python tocados. `graphify update .` rodado.

## Testes

- `tests/test_app_hangar.py` + `tests/test_mcp_oauth.py`: todos passam.
- Suíte completa (`.venv\Scripts\python -m pytest`, com o código final): **611 testes, 608 passam, 3 falham** — os 3 de
  `tests/test_observability.py`, por falta de `prometheus_client` e `opentelemetry` no `.venv` (dependências de
  `central/requirements.txt` não instaladas; `ModuleNotFoundError` / "prometheus_client ausente"). Nada relacionado a
  esta mudança; nenhum outro teste quebrou.
- E2E contra a instância de dev (script do fluxo do contrato: descoberta → registro → authorize com porta 49152 →
  login/consentimento → token `app mcp` → `/api/app/me` → dispositivo → heartbeat → design tokens → `/mcp` 200 →
  overview admin → token `app` no admin 403 → `/oauth/revoke` → heartbeat `revoked`): OK, com `dev-membro` e `dev-admin`.
- A UI do console não foi aberta num navegador nesta sessão (sem ferramenta de navegador disponível); os scripts passam
  na checagem de sintaxe (`node`) e no teste de globais. Vale uma olhada em `http://localhost:8091/ui/#/app`.

## Instância de desenvolvimento (rodando)

- URL: **http://localhost:8091** (responde em `127.0.0.1` e `::1`; só loopback, nada exposto na rede).
- Console: `http://localhost:8091/ui/` → App Hangar. Consentimento: `/app/#/oauth`.
- Pasta: `C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091` — `hangar.db` (SQLite), `start.ps1` (variáveis de
  ambiente + comando), `serve.py` (uvicorn com um socket em cada loopback), `central.log` (UTF-16), `launcher.pid`.
- Subir de novo: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\valteresj\AppData\Local\Temp\hangar-dev-8091\start.ps1`
  (o processo fica no terminal; para segundo plano use `Start-Process … -WindowStyle Hidden`, como foi feito).
- Parar: encerrar o processo que escuta na 8091 (`Get-NetTCPConnection -LocalPort 8091 -State Listen`).
- Isolamento: `DOCKER_HOST=tcp://127.0.0.1:1` (a subida da central limpa containers de job do Docker do host — com o
  Docker real, apagaria os da instalação em uso), `PLUGIN_EGRESS=open`, `SCHEDULER_ENABLED=0`, sem catálogo/registry
  externos. Não toquei no container `agent-hangar-central-1`, no Postgres dele, no `.env` nem no `docker compose`.
- **Credenciais só de teste** (criadas por mim, pela API com o `ADMIN_TOKEN`, como o `hangar setup` faz):
  - admin: usuário `dev-admin`, senha `Hangar-Dev-2026!` (e-mail `dev-admin@hangar.test`)
  - membro: usuário `dev-membro`, senha `Hangar-Dev-2026!` (e-mail `dev-membro@hangar.test`)
  - `ADMIN_TOKEN` da instância: em `start.ps1`.
- O banco já tem 2 clientes OAuth "Hangar Desktop" e 2 dispositivos `E2E-PC` (revogados pela saída) do E2E.

## Pedidos ao chief

1. **Contrato — revogação pelo admin é definitiva para aquele `device_id`**: implementei 403 no registro de um
   dispositivo revogado pelo admin (o contrato cita "403 = dispositivo revogado"). Não há rota para reativar. Se a
   intenção for "revogar = forçar novo login", basta trocar a regra em `register_device`; ou acrescentar ao contrato
   `POST /api/app/admin/devices/{id}/reactivate`. O app deve tratar esse 403 (gerar novo `device_id` não é o caminho:
   avisar a pessoa).
2. **Contrato — heartbeat com token encerrado**: responde 200 `{"status":"revoked"}` (não 401) quando a autorização
   foi revogada/bloqueada ou a pessoa desligada; 401 só para token desconhecido ou expirado. Vale registrar no §2.
3. **Contrato — formato dos design tokens**: nomes = variáveis CSS sem `--` (`panel-2`, `mark-ink`…); `dark` é a paleta
   completa (não só as diferenças); `version` = hash do conteúdo. Vale registrar no §6.
4. **Contrato — escopos**: o servidor concede a interseção entre o pedido e os escopos do registro (o app precisa
   registrar com `"scope": "app mcp"`, como o contrato já diz). Um `client_id` registrado antes sem `scope` só recebe
   `mcp` — o app deve registrar de novo nesse caso.
5. **`localhost` no Windows**: com `PUBLIC_BASE_URL=http://localhost:8091`, a instância responde em `127.0.0.1` e `::1`.
   Em produção atrás de proxy isso não importa; só registrei em Desenvolvimento.
6. **Ambiente**: o `.venv` não tem `prometheus-client` nem `opentelemetry-*` (estão em `central/requirements.txt`), por
   isso 3 testes de `tests/test_observability.py` falham — independente desta mudança. Não instalei nada.
7. CHANGELOG/release notes não foram tocados (ficam para o release).

## Riscos conhecidos
- `scopes_supported` do servidor agora anuncia `app`: clientes MCP que pedem todos os escopos continuam recebendo só `mcp`
  (testado), mas um cliente que pedir **apenas** `app` sem tê-lo registrado recebe `invalid_scope`.
- Grants antigos viram `mcp` pela migração (`server_default`), sem efeito para Claude.ai/ChatGPT.
- O heartbeat é a única rota que aceita um token `aho_` não autenticado (para responder `revoked`); ela não devolve dado
  nenhum além do status e só para tokens que existiram.
- Sincronização de dispositivos é feita na leitura (lista/overview/heartbeat) e no desligamento; uma autorização
  revogada fica com o dispositivo `active` no banco até a próxima leitura (o que o admin vê já sai sincronizado).
