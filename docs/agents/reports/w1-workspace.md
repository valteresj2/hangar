# w1-workspace — M1 (Desktop): Início, Meus agentes, eventos e deep links

Feature novo **`workspace`**. Especificação: `docs/platform/m1-contract.md`. A seção 4 foi preenchida pelo agente
`platform`, e o parse segue os exemplos reais dela.

## O que foi feito

### 1. Cliente das rotas do membro e do SSE (main)

- `src/main/features/workspace/parse.ts` (puro) valida o JSON da plataforma e devolve os tipos do app:
  - `parseHome` (`/api/me/workspace`), `parseDecisions` (`/api/decisions`, com `toDecide` sem `notice`),
    `parseChart` (`/api/org-chart?mine=1`), `parseInbox` (`counts`) e `parseEvent` (os 5 tipos da M1).
  - Lixo vira valor vazio, não exceção.
  - Slugs e ids são checados, e os textos têm tamanho limitado.
  - Data sem fuso (ex.: `my_tasks[].created_at`) é tratada como UTC, como diz a seção 4.
  - O título da decisão é `question`, senão `task.title`, senão `tool`.
- `src/main/features/workspace/sse.ts`:
  - `SseParser`, incremental e segundo a especificação: CRLF, `\r` partido entre chunks, comentários, `data`
    multilinha, `id` sem `data`, `retry`.
  - `EventStream`:
    - reconecta com `Last-Event-ID` e backoff exponencial (1 s a 60 s, ±20 %);
    - considera morta a conexão sem bytes por 75 s (o keepalive é de 25 s);
    - faz polling de 60 s enquanto o stream está caído;
    - depois de uma queda, ao voltar, pede um refresh completo;
    - retenta só a cada 10 min numa plataforma sem `/api/app/events` (404);
    - quando a plataforma fecha o stream sozinha (a cada 30 min), reconecta sem passar para "polling".
- `src/main/features/workspace/controller.ts`:
  - **Estado e cache.** Mantém `WorkspaceState` (home, decisions, chart e inbox como `Loadable`), com cache em memória
    e em disco (`hangar-data/workspace/cache.json`, chaveado por `<url> <userId>`, sem segredos). O cache é apagado no
    logout.
  - **Eventos aplicados na hora.** O badge muda no mesmo instante; detalhes chegam num refresh agrupado 1,5 s depois.
    - `decision.created` entra como um item provisório, com o nome do agente vindo do slug quando ele é conhecido.
    - `decision.decided` sai da lista.
    - `agent.status` atualiza o status nas listas.
    - `models.changed` chama a sincronização de modelos do `platform`.
  - **Login recusado.** Um 401/403 depois do refresh pede ao `platform` que confira o login (`recheckPlatform`), no
    máximo a cada 30 s, e o logout segue o caminho de sempre.
  - **"Vistos recentemente".** Agentes, Digital employees e tarefas abertos pelo app ficam em `recent.json` (8 itens).
  - Abre o portal (`<url>/app#/…`) **só por uma lista fechada de telas** (`PortalTarget`, validada no main).
- **IPC tipado** em `src/shared/features/workspace.ts`: `workspace:state`, `workspace:refresh(scope)`,
  `workspace:openPortal(target, label?)` e `workspace:takeNavigation`, mais os eventos `workspace:event:state` e
  `workspace:event:navigate`.
- **Usa o login do feature `platform`** pelo `api.ts` dele. Novos exports: `platformGet`, `platformStream`,
  `platformLogin`, `platformUrl`, `platformState`, `onPlatformState`, `recheckPlatform` e `syncPlatformModels`.
  - Para isso, mudanças pequenas e aditivas em `platform/client.ts` (`ApiClient.stream()`: só a espera pelos
    cabeçalhos tem timeout; um 401 faz um refresh e uma nova tentativa) e em `platform/controller.ts`
    (`onStateChange`, `apiClient`, `currentLogin`).

### 2. Seção Agent Hangar na sidebar

- `WorkspaceNav` fica acima das sessões, em `sessions/Sidebar.tsx` (só a montagem). A seção é recolhível e lembra o
  estado no `localStorage`, com try/catch.
- Itens:
  - **Início** e **Meus agentes**: telas nativas.
  - **Decisões** e **Caixa de entrada**: com badge ao vivo; abrem o portal (↗) até a M2.
- Um ponto mostra o estado ao vivo: verde para "Ao vivo", cinza para "atualizando a cada 60 s".
- Recolhida, a seção mostra a soma dos badges.
- Sem login aparece "Conecte à plataforma", que abre Configurações → Plataforma. Com a plataforma em modo `off`, a
  seção some.

### 3. Telas Início e Meus agentes

- No tema da plataforma, claro e escuro. Os screenshots foram conferidos.
- **Início**:
  - saudação ("Bom dia/Boa tarde/Boa noite, <nome>"), o workspace e o estado ao vivo;
  - banner quando `llm_ready` é falso;
  - KPIs: Para você decidir, Meus agentes, Trabalhando agora e Custo no mês;
  - linha dos agentes pessoais;
  - cartões: Decisões, Trabalhando agora, Minhas tarefas, Meus agentes (6 primeiros, "Ver todos" vai à tela nativa) e
    Vistos recentemente.
- **Meus agentes**:
  - grupos Pessoais, Do time que eu gerencio, e Agentes que eu criei ou mantenho;
  - em cada linha: tipo (**Digital employee** ou **Agente**), status, modelo, harness e nível (do organograma), time,
    decisões abertas, tarefas atrasadas, custo de 30 dias, **último uso**, "Trabalhando em" e o agendamento;
  - "Abrir ↗" leva o detalhe ao portal até a M3.
- Estados de carregamento (spinner), vazio (os textos do portal) e erro:
  - sem dados, cartão de erro com "Tentar de novo";
  - com cache, faixa "Mostrando dados de há X min…" com "Tentar de novo".

### 4. Deep links `hangar://open/<rota>`

- **Parse** (`parseDeepLink`, em `src/shared/features/workspace.ts`), por lista fechada. Recusa query, fragmento,
  credenciais, porta, `%`, segmentos vazios ou extras e qualquer coisa fora da lista; tolera uma `/` final.

  | Rota                                                                 | Destino                        |
  | -------------------------------------------------------------------- | ------------------------------ |
  | `workspace`, `workspace/home`                                        | Início (nativo)                |
  | `workspace/agents`, `mine`                                           | Meus agentes (nativo)          |
  | `decisions[/<id>]`, `inbox`                                          | portal, até a M2               |
  | `tasks/<id>`, `agents/<slug>`, `employees/<slug>`, `org`, `connect-ai`, `my-issues` | portal               |

- **Main** (`src/main/index.ts`, via `workspace/api.ts`):
  - `registerProtocol()`, só no app instalado. Em dev, só com `HANGAR_DEV_PROTOCOL=1`; nunca com `HANGAR_E2E`.
  - `second-instance` lê o link do argv.
  - `open-url` (macOS): os links que chegam antes do `ready` ficam na fila.
  - O link do argv na primeira abertura é tratado depois de criar a janela.
- **Navegação**:
  - Telas nativas focam a janela e trocam a tela por `workspace:event:navigate`.
  - Uma janela ainda carregando pega o link com `takeNavigation`, válido por 2 min.
  - Sem plataforma configurada, o link vai ao Início, que mostra "Conecte à plataforma".
- Um link recusado só gera log.
- O instalador já declara o protocolo (agente release: `electron-builder.yml` → `protocols` e
  `build/installer.nsh`).

### 5. Testes

- **Plataforma falsa** (`tests/mock-platform/server.ts`, mais os dados em `tests/mock-platform/workspace.ts`, no
  formato das rotas reais):
  - Rotas novas: `GET /api/me/workspace`, `/api/decisions`, `/api/org-chart` (sem `mine=1`, recusa o token do app
    com 403), `/api/inbox` e `/api/app/events`. O SSE tem `id` crescente, replay depois do `Last-Event-ID` e
    keepalive configurável.
  - Helpers: `addDecision`, `emitEvent`, `dropStreams`, `streams()`, `setEventsEnabled(false)` (devolve 404) e
    `eventResumes`.
- **Unitários** (`tests/unit/workspace.test.ts`, 45):
  - parse das 4 rotas, com lixo, datas sem fuso e o título pela `tool`;
  - eventos válidos e inválidos;
  - `SseParser` com todos os pontos de corte;
  - `EventStream` com timers falsos: ao vivo, fechamento limpo, queda que leva a polling e depois a refresh, backoff,
    404 que retenta raramente, conexão silenciosa;
  - deep links: as rotas da lista e 27 formas recusadas;
  - `portalHash` e `validPortalTarget`.
- **E2E** (`tests/e2e/workspace.spec.ts`, 2 testes):
  1. O fluxo completo:
     - conectar;
     - Início com os dados;
     - `decision.created` aumenta o badge de 1 para 2, e o `inbox.changed` aumenta a caixa;
     - abrir um agente vai ao portal e entra em "Vistos recentemente";
     - Decisões e Caixa de entrada abrem o portal;
     - **deep link por uma segunda execução real do app** (`spawn` do Electron com o mesmo `--user-data-dir`) abre
       Meus agentes;
     - `agent.status` atualiza a lista;
     - links inválidos são ignorados;
     - `decisions/90` abre o portal;
     - queda do stream e reconexão com o `Last-Event-ID` certo;
     - disconnect limpa tudo.
  2. Plataforma sem `/api/app/events`: entra em polling. Plataforma fora do ar: o cache continua na tela, com o erro
     e "Tentar de novo".
- **E2E opt-in contra a 8091** (`tests/e2e/workspace-real.spec.ts`):
  - login do `dev-membro` pela UI (o "navegador" é o teste);
  - badges e KPIs iguais ao que o portal devolve para a mesma pessoa;
  - **badge ao vivo pelo SSE real**: o membro marca um item como lido no portal, e depois como não lido de novo, o que
    restaura o estado;
  - deep link para Meus agentes com todos os agentes da pessoa;
  - "Abrir" leva ao portal da instância.
  - **Passou contra `http://localhost:8091`**: "Minha empresa", 2 employees, 1 para decidir, 4 não lidos.

## Verificação

- `format:check`: só falha `docs/platform/m1-contract.md`, que o agente `platform` editou. Os meus arquivos estão
  formatados.
- `lint`: 0 erros. Os 110 avisos são os mesmos de antes, e os arquivos desta missão estão limpos.
- `typecheck`: passou.
- `typecheck:tests`: passou.
- `npm test`: 171 de 171.
- `npm run test:e2e`: 13 passaram e 3 foram pulados (os opt-in sem variáveis).
- `workspace-real.spec.ts` contra a 8091: 1 de 1.
- `npm run build`: passou.
- `graphify update .`: rodado.
- Nenhum Electron órfão.

## Como testar

```powershell
npm test -- tests/unit/workspace.test.ts
npm run build; npx playwright test tests/e2e/workspace.spec.ts
# Opt-in contra a instância de dev (a credencial do dev-membro está em docs/agents/reports/w1-platform.md;
# passe-a só por variável de ambiente, nunca num arquivo):
$env:HANGAR_PLATFORM_URL='http://localhost:8091'; $env:HANGAR_PLATFORM_MEMBER_USER='dev-membro'
$env:HANGAR_PLATFORM_MEMBER_PASSWORD='<senha>'; npx playwright test tests/e2e/workspace-real.spec.ts
```

**Manual:**

1. Conecte em Configurações → Plataforma.
2. Na sidebar, use **Agent Hangar → Início / Meus agentes**.
3. Deep link em dev: rode o app com `HANGAR_DEV_PROTOCOL=1` (isso registra o dev como dono de `hangar://` no usuário
   do Windows) e abra `hangar://open/workspace/agents` no navegador. Ou, com o app aberto, rode
   `electron . hangar://open/workspace/agents`.

## Pedidos ao chief

1. **`App.tsx`: renderizar a tela do workspace no `<main>`.**
   - Hoje, enquanto o `App.tsx` não renderiza a tela, o `WorkspaceHost` (montado dentro do `WorkspaceNav`) faz um
     portal para o `<main>`. Uma regra `:global(main):has(> .host) > :not(.host) { display: none }` em
     `workspace.module.css` esconde a sessão.
   - Mudança:

     ```tsx
     const workspaceView = useUi((s) => s.workspaceView)
     …
     <main className={styles.center}>
       {workspaceView ? <WorkspaceView view={workspaceView} /> : session ? <ChatView … /> : <NewSessionView />}
     </main>
     ```

   - Depois disso, eu tiro o `<WorkspaceHost />` do `WorkspaceNav` e a regra `:has` do CSS.
2. **Arquivos do chief editados pelas exceções desta missão** (confira):
   - `src/main/features/index.ts`: `workspaceFeature`.
   - `src/main/index.ts`: `registerProtocol`, `second-instance` com argv, `open-url` e o link do argv depois do
     `createWindow`.
   - `src/renderer/src/core/ui.ts`: `workspaceView`, `openWorkspace(view)` (limpa a sessão ativa) e
     `closeWorkspace()`; `selectSession` limpa o `workspaceView`, então clicar numa sessão ou em "Nova sessão" sai do
     workspace.
   - `src/renderer/src/features/sessions/Sidebar.tsx`: `<WorkspaceNav />` entre o topo e a lista.
3. **Feature `platform`.** Além do `api.ts`, precisei de duas mudanças aditivas: `client.ts`, com `ApiClient.stream`
   (o SSE com o mesmo refresh de token), e `controller.ts`, com `onStateChange`, `apiClient` e `currentLogin`. Nenhum
   comportamento existente mudou.
4. **`docs/platform/m1-contract.md`** está fora do Prettier depois da seção 4 do agente `platform`: rode
   `npx prettier --write docs/platform/m1-contract.md`.
5. **Docs.**
   - `docs/ARCHITECTURE.md` e `docs/FEATURES.md`: incluir o feature `workspace`.
   - `docs/SECURITY.md`: deep links por lista fechada, portal só no URL configurado e só por `PortalTarget`, IPC que
     não aceita URL.
6. **Opcional:** "Início" e "Meus agentes" na paleta Ctrl+K (feature `settings`), chamando
   `useUi.getState().openWorkspace(…)`.
7. **Dependências:** nenhuma nova.

## O que ficou faltando / riscos conhecidos

- **"Último uso".** A plataforma não manda um campo de último uso.
  - O app lê `last_used_at`, `last_run_at` ou `last_task_at`, se vierem. Sem eles, mostra "agora" quando o agente
    está numa tarefa e "—" no resto.
  - Sugestão para o agente `platform` (M2): incluir `last_used_at` em `agents[]` e `built_agents[]`.
- **Avatares.** As imagens da plataforma (`avatar_url` relativa) não são carregadas no app; ele usa as iniciais. Isso
  evita CSP e requisições de imagem com cookie.
- **Item provisório da decisão.** O `decision.created` mostra um item provisório ("aprovação" mais o título do evento)
  até o refresh de 1,5 s trazer o tipo real.
- **Portal no navegador.** Os links do portal dependem da sessão da pessoa no navegador; o portal pede login se
  preciso. É o comportamento esperado até a M2/M3.
- **Cache em disco.** Guarda nomes de agentes e tarefas da pessoa, sem segredos. É apagado no logout e ignorado se
  for de outra conta ou de outra versão.
- **Protocolo em dev.** O app em dev não registra `hangar://`, para não roubar os links do app instalado.
- **Host via portal** (pedido 1). Se o `<main>` do `App.tsx` mudar de estrutura, a tela some até o pedido 1 entrar.
- **Fora da M1:** notificações nativas (M2), decidir pelo app (M2) e "Promover para o time" (fica no portal).

## Complemento

O chief passou a renderizar `<WorkspaceView view={workspaceView} />` no `<main>` do `App.tsx` e a esconder o painel
lateral com o workspace aberto. Isso resolve o pedido 1 e o risco "Host via portal".

- **Portal removido**: saíram o `WorkspaceHost`, o `createPortal`/`useLayoutEffect`, o export do `index.tsx`, as duas
  montagens no `WorkspaceNav` e a regra `:global(main):has(> .host)` do `workspace.module.css`. O `WorkspaceView` agora
  traz o próprio contêiner com rolagem (`.screen`).
- **Registro do `hangar://` com o executável certo**:
  - A decisão fica em `src/main/features/workspace/protocol.ts` (`protocolClient`, função pura). O
    `registerProtocol()` do `api.ts` aplica o resultado.
  - **Windows portátil** (app empacotado com `PORTABLE_EXECUTABLE_FILE`): chama
    `app.setAsDefaultProtocolClient('hangar', PORTABLE_EXECUTABLE_FILE, [])`. É o `.exe` que a pessoa abriu, e não a
    pasta temporária onde ele se extrai.
  - **AppImage** (Linux com `APPIMAGE`): registra com `process.env.APPIMAGE`, o arquivo em si, e não o ponto de
    montagem de cada execução. O link ainda depende de um `hangar.desktop` em `~/.local/share/applications`, como
    explica o item 2 dos pedidos do `w1-release.md`.
  - **NSIS, `.deb` e mac**: o padrão do Electron. O instalador também declara o protocolo, e registrar de novo não
    atrapalha.
  - **Dev**: só com `HANGAR_DEV_PROTOCOL=1`. **E2E** (`HANGAR_E2E`): nunca.
  - Cada variável só vale na sua própria plataforma.
- **Testes** em `tests/unit/workspace-protocol.test.ts` (7):
  - `protocolClient`: portátil, AppImage, instalado (win, linux, mac), variável da plataforma errada, dev com e sem
    `HANGAR_DEV_PROTOCOL`, e2e.
  - `registerProtocol` com o `electron` mockado: confere a chamada exata nos dois casos e no instalado.
- **Verificação**:
  - `format:check`: passou.
  - `lint`: 0 erros; os 110 avisos são de antes, e os arquivos do workspace estão limpos.
  - `typecheck`: passou.
  - `typecheck:tests`: passou.
  - `npm test`: 178 de 178.
  - `npm run test:e2e`: 13 passaram e 3 foram pulados (os opt-in).
  - `graphify update .`: rodado.
  - Nenhum Electron órfão.
