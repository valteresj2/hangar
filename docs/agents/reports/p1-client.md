# Relatório — Fase 1 (app): conexão com a plataforma Agent Hangar (`platform`)

## O que foi feito

### Main (`src/main/features/platform/`)

| Arquivo | O quê |
|---|---|
| `policy.ts` | Política do Windows lida com `reg query` (sem módulo nativo): `HKLM` e depois `HKCU` `\Software\Policies\Hangar`, `PlatformUrl` e `Mode` (`REG_SZ`/`REG_EXPAND_SZ`, nomes sem diferenciar maiúsculas). HKLM ganha valor a valor. `parseRegQuery`/`readPolicy(query)` são puros/injetáveis (testados com saída simulada). |
| `pkce.ts` | Verifier (32 bytes → 43 chars base64url), challenge S256, `state` aleatório e comparação em tempo constante (`timingSafeEqual`). |
| `oauth.ts` | Descoberta RFC 8414 (inclusive base com caminho), registro dinâmico RFC 7591 exatamente como o contrato (`software_id: hangar-desktop`, `redirect_uris: ["http://127.0.0.1/callback"]`, `scope: "app mcp"`), servidor efêmero em `127.0.0.1:<porta aleatória>/callback` (página "Pode fechar esta aba", ignora callbacks com `state` errado com 400, timeout de 5 min, cancelável por `AbortSignal`, fecha sozinho), checagem do `iss` (RFC 9207), troca do código, refresh, revogação (RFC 7009). Sem Electron: `fetch` e o abridor de navegador são injetados. |
| `client.ts` | `TokenManager`: refresh **single-flight** (pedidos concorrentes compartilham um só `refresh_token` grant; quem chega com o token velho recebe o novo sem gastar o refresh de novo — a plataforma derruba o grant se um refresh já trocado reaparece) e refresh antecipado (1 min antes de expirar). `ApiClient`: Bearer, um refresh + uma repetição em 401, erros legíveis em pt-BR (`errors.ts`). |
| `storage.ts` | `<userData>/hangar-data/platform/`: `config.json` (url/modo do usuário), `device.json` (`device_id` UUID), `clients.json` (cache do `client_id` por URL), `account.json` (último `/me`, sem segredos) e `tokens.json` (TokenSet cifrado com `safeStorage.encryptStringAsync`; recifra quando `shouldReEncrypt`). |
| `controller.ts` | Estado efetivo (política > usuário > padrão `optional`), login, registro do dispositivo após o login, heartbeat ao iniciar, a cada 15 min e ao voltar da suspensão (`powerMonitor.resume`), `revoked` → apaga tokens, marca o dispositivo, notifica (notificação do Windows + aviso na UI). Rede: `net.fetch` (proxy/certificados do sistema), `credentials: 'omit'`. Navegador: `openExternalLink` do core. http:// só é aceito para localhost. |
| `api.ts` | `canCreateSessions()` / `assertCanCreateSessions()` para o sessions. |
| `index.ts` | Feature `platform` (IPC tipado com `handle()`); lê política e tokens antes da janela abrir. |

Semântica de revogação alinhada com a implementação real da plataforma (`central/app/services/app_hangar.py`):
o heartbeat responde `revoked` também para o token de um grant encerrado. Por isso o `sync` faz o heartbeat **antes**
do `/me` quando o dispositivo já está registrado; e quando um refresh é recusado, o app pergunta ao heartbeat com o
token antigo se foi revogação (mensagem "Este dispositivo foi revogado…") ou só expiração ("Sua sessão expirou…").
Registro recusado com 403 (dispositivo revogado pelo admin) desconecta com a mensagem da plataforma.

### Shared (`src/shared/features/platform.ts`)

Canais `platform:state|setConfig|connect|cancelConnect|disconnect|refresh` e evento `platform:event:state`
(`PlatformState`: config efetiva + origem/trava de cada valor, status, usuário, empresa, times, dispositivo, erro,
aviso, último heartbeat, `canCreateSessions`), declarados por _declaration merging_.

### Renderer (`src/renderer/src/features/platform/`)

- `PlatformSection` — Configurações → **Plataforma**: URL (Salvar/Enter), modo (Desligado/Opcional/Obrigatório),
  valores da política aparecem travados ("🔒 Definido pela política da empresa", com a chave no tooltip), estado,
  Conectar/Cancelar login/Atualizar/Desconectar (com confirmação), cartões Conta (avatar ou iniciais, nome, e-mail,
  empresa, papel, times, versão da plataforma) e Dispositivo (nome, ID, estado, registro).
- `PlatformStep` — passo **Conectar à plataforma** do onboarding.
- `PlatformIndicator` — rodapé da sidebar (avatar/inicial, empresa, usuário · estado; abre Configurações → Plataforma;
  em vermelho "Conectar à plataforma" quando o modo é obrigatório e não há conexão; some no modo Desligado).
- `PlatformRequiredNotice` — faixa na tela de nova sessão no modo obrigatório sem conexão, com botão de conectar.
- `api.ts` — store zustand espelhando o `PlatformState` (uma assinatura do evento para todo o renderer).
- `platform.module.css` — só variáveis do tema (funciona claro e escuro; conferido com capturas).

### Integrações permitidas pelo briefing (arquivos de outros donos)

- `src/main/features/index.ts`: `platformFeature` registrado (por último).
- `src/main/features/sessions/index.ts`: `sessions:create` chama `assertCanCreateSessions()` antes de criar.
- `src/renderer/src/features/sessions/NewSessionView.tsx`: `<PlatformRequiredNotice />` acima do composer e
  "Iniciar" desabilitado quando `!canCreateSessions`.
- `src/renderer/src/features/sessions/Sidebar.tsx`: `<PlatformIndicator />` depois do rodapé de projetos.
- `src/renderer/src/features/settings/SettingsView.tsx`: entrada `platform` → "Plataforma" (depois de Provedores).
- `src/renderer/src/features/onboarding/{OnboardingView.tsx,api.ts}`: passo `platform` depois de Boas-vindas; oculto
  no modo Desligado; no modo Obrigatório sem conexão o botão "Pular", o Esc e os passos seguintes ficam bloqueados até
  conectar; no Opcional o botão vira "Pular este passo".

### Testes

- `tests/unit/platform.test.ts` (20 testes): PKCE (vetor do RFC 7636 apêndice B), comparação de `state`, leitura de
  política com saída de `reg query` simulada (HKLM > HKCU, valores inválidos, chave ausente), servidor de loopback
  (state errado ignorado, timeout, cancelamento, access_denied), login completo contra o mock (registro uma vez,
  cache do `client_id`, consentimento negado), rotação de refresh e detecção de reuso, refresh concorrente (5
  chamadas → 1 pedido), `ApiClient` com 401 → refresh → repetição (3 pedidos concorrentes → 1 refresh), refresh
  antecipado, grant revogado → `session_expired`, plataforma fora do ar → mensagem em pt-BR.
- `tests/mock-platform/server.ts`: plataforma falsa (descoberta, registro, authorize com auto-aprovação e loopback de
  porta livre, token com PKCE e refresh rotativo com detecção de reuso, revoke, `/api/app/me`, devices, heartbeat com a
  mesma semântica de `revoked` da plataforma real, controles `revokeDevice`/`expireAccessTokens`/`setConsent`).
- `tests/e2e/platform.spec.ts` (2 testes, Playwright + Electron; o "navegador" é um `fetch` que segue o redirect):
  1. obrigatório: sessão recusada → conectar pela UI → `/me` → dispositivo registrado → heartbeat → token expirado
     renovado uma vez → admin revoga o dispositivo → desconectado, aviso na tela, sessão recusada de novo, tokens
     apagados; confere também que `tokens.json` não contém os tokens em claro;
  2. opcional: conectar e desconectar pela UI revoga o grant na plataforma.
- `tests/e2e/platform-real.spec.ts` (opt-in, pulado sem variáveis): o mesmo fluxo contra uma instância **de
  desenvolvimento** real — `HANGAR_PLATFORM_URL`, `HANGAR_PLATFORM_USER`, `HANGAR_PLATFORM_PASSWORD` (usuário admin
  de login local; o teste revoga o dispositivo no fim).

## Verificação

- `npm run typecheck`: ok. `npm run typecheck:tests`: ok. `npm run build`: ok.
- `npx eslint` nos meus arquivos: sem erros nem avisos. Prettier: ok.
- `npm test`: 111/111 (inclui os 20 novos).
- `npx playwright test tests/e2e/platform.spec.ts`: 2/2.
- Suíte e2e completa: 8 passaram, 1 pulado (o opt-in real, sem variáveis) e 1 falhou **sem relação com este
  feature**: `panels.spec.ts › teste de conexão de um perfil com o mock devolvendo 401` falha em
  `getByRole('button', { name: 'Provedores', exact: true })` porque a seção Geral (`settings/sections/General.tsx`,
  sem alterações desde o commit) também tem um botão "Provedores". (Antes disso o teste também esbarrava no `title`
  do meu indicador da sidebar, que continha "Configurações"; troquei o texto e isso foi resolvido.) Sugestão para o
  dono do teste: `page.getByRole('navigation').getByRole('button', { name: 'Provedores' })`.
- Integração real contra `http://localhost:8091`: ver abaixo.

## Integração real

Contra a instância de desenvolvimento do agente da plataforma (`http://localhost:8091`, usuário de teste `dev-admin`
do relatório `p1-platform.md`; a instalação do usuário em `:8090` não foi tocada):

```powershell
$env:HANGAR_PLATFORM_URL='http://localhost:8091'; $env:HANGAR_PLATFORM_USER='dev-admin'
$env:HANGAR_PLATFORM_PASSWORD='<senha do relatório p1-platform>'; npx playwright test tests/e2e/platform-real.spec.ts
```

Resultado: **passou**. Registro dinâmico → authorize (porta livre no loopback aceita; `scope=app mcp`, S256) →
login local + consentimento (feitos por HTTP com cookie e CSRF, como o portal) → retorno ao loopback → troca do código
→ `/api/app/me` ("dev-admin@hangar.test", empresa "Minha empresa") → dispositivo registrado e visto como `active` em
`/api/app/admin/devices` → heartbeat → admin revoga o dispositivo → o heartbeat seguinte desconecta o app com "Este
dispositivo foi revogado na plataforma. O Hangar foi desconectado." e as sessões voltam a ser recusadas (modo
obrigatório). O dispositivo de teste ficou revogado na instância de dev (ID `4d1ff71b-…`, numa pasta de usuário
temporária).

## Como testar

1. `npm run dev` → Configurações → Plataforma → URL `http://localhost:8091` → Salvar → **Conectar à plataforma** →
   entrar no navegador com o usuário de teste da instância de dev → aprovar → voltar ao app.
2. Ver Conta/Dispositivo; no console da plataforma (`/ui/` → App Hangar → Dispositivos) o computador aparece.
3. Modo **Obrigatório** + Desconectar: nova sessão bloqueada (faixa vermelha, "Iniciar" desabilitado, IPC recusa).
4. Revogar o dispositivo no console → Configurações → Plataforma → Atualizar (ou esperar o heartbeat): app desconecta e
   avisa.
5. Política: `reg add HKCU\Software\Policies\Hangar /v Mode /t REG_SZ /d required` (precisa de admin; a chave
   Policies costuma ser protegida) e reiniciar o app: o modo aparece travado.

## Pedidos ao chief

1. **Sessões criadas fora do `sessions:create`** não passam pela trava do modo obrigatório: tarefas agendadas
   (`settings/schedules.ts` faz `db('sessions').put` direto), runs do Lab (`lab/runs.ts`), branch de sessão
   (`engine/branch.ts`) e importação do CLI (`sessions/cli.ts`). Sugestão: chamar `canCreateSessions()` de
   `src/main/features/platform/api.ts` nesses pontos (agendada: pular a execução e notificar "conecte à plataforma").
2. `docs/ARCHITECTURE.md`: acrescentar `platform` à lista de features e `platform/api.ts` (`canCreateSessions`,
   `assertCanCreateSessions`) à lista de APIs entre features. O feature não usa o `bus`.
3. `docs/FEATURES.md`: seção do feature `platform` (Configurações → Plataforma, passo do onboarding, indicador).
4. Nenhuma dependência nova.
5. `tests/e2e/panels.spec.ts:63`: seletor ambíguo pré-existente (ver Verificação).

## Riscos conhecidos / decisões

- **Offline com login válido conta como conectado** no modo obrigatório (status `error` = "Sem resposta da
  plataforma", tokens mantidos): uma queda de rede não trava o trabalho. Se a política quiser bloquear também offline,
  é trocar `connected()` no controller.
- **Dispositivo revogado pelo admin não volta**: a plataforma recusa (403) o mesmo `device_id` para a mesma pessoa.
  O app mantém o `device_id`; o usuário vê a mensagem da plataforma e precisa falar com o admin. Revogações "de
  sistema" (logout, grant expirado) se reativam num login novo.
- Se o admin bloquear o app (client) na plataforma, o `/oauth/authorize` mostra a página de erro no navegador e o app
  só sai do "Conectando…" pelo botão "Cancelar login" ou pelo timeout de 5 min. Um `invalid_client` na troca do código
  limpa o cache do `client_id` (o próximo login registra de novo).
- `reg query` lê a visão de registro nativa do processo (64 bits). Políticas gravadas só na visão de 32 bits
  (`WOW6432Node`) não são vistas.
- A política é lida na inicialização e em "Atualizar"; mudar a política com o app aberto só vale depois disso.
- `net.fetch` usa a sessão padrão do Electron (sem cookies, `credentials: 'omit'`).
- Escopo: se a plataforma devolver um `scope` sem `app` (versão antiga), o login falha com mensagem clara.
