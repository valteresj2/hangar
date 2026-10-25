# Segurança do Hangar

O Hangar roda o Claude Code com acesso real à máquina: ele lê e escreve arquivos e executa comandos. O objetivo não é
impedir isso (é o produto), e sim garantir duas coisas: que conteúdo não confiável (o que o agente escreve, páginas
abertas no navegador embutido, harnesses gerados) **não ganhe mais poder do que já tem**, e que nada perigoso aconteça
**sem o usuário ver e decidir**.

## Modelo de ameaças

| Origem                                                           | O que pode tentar                                                                                                                                                               | Quem confia nela                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Conteúdo do agente** (respostas, markdown, arquivos escritos)  | Injetar HTML/links que levem a janela para fora do app; abrir protocolos do sistema; induzir o usuário a aprovar algo                                                           | Ninguém: é texto não confiável                  |
| **Artifacts** (HTML/SVG/Mermaid/Motion escritos pelo agente)     | Rodar script com acesso ao Hangar; ler outros arquivos; navegar a janela                                                                                                        | Ninguém: renderizados isolados                  |
| **Webviews** (navegador embutido, dev servers)                   | Páginas da internet chamando o IPC do Hangar, pedindo permissões (câmera, microfone…), abrindo popups e downloads                                                               | Ninguém: equivalem a uma aba de navegador comum |
| **Hooks e scripts do Lab** (harness vencedor, variantes manuais) | `.claude/settings.json` com hooks/`apiKeyHelper`/`statusLine`, scripts em `.claude/scripts` e em skills, comandos `!` em comandos/skills, permissões amplas (`Bash(*)`) e `env` | Só depois de o usuário revisar e confirmar      |
| **Segredos de provedor** (chaves de API, tokens de gateway)      | Vazar para o renderer, logs, transcrições ou mensagens de erro                                                                                                                  | Só o processo main, cifrados em disco           |
| **Modo "Ignorar permissões"**                                    | Permanecer ativo num processo depois que o usuário saiu dele                                                                                                                    | Só enquanto a sessão estiver nesse modo         |

Fora do escopo: o próprio Claude Code executando o que o usuário autorizou, e máquinas já comprometidas (quem
controla a conta do Windows lê o que o Hangar lê).

## Camadas

### 1. Renderer isolado

- Todas as janelas (principal e Quick Entry) usam `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
  e `webSecurity: true` (`rendererWebPreferences`, em `src/main/core/window.ts`).
- O preload (`src/preload/index.ts`) roda sandboxado e expõe só `window.hangar` (`invoke`/`send`/`on`/`pathForFile`/
  `platform`) via `contextBridge`. Nenhuma API do Node chega à página.
- CSP no `index.html`: `script-src 'self'` (sem eval nem inline), sem WebAssembly.

### 2. Guarda de IPC (`src/main/core/ipcGuard.ts`)

- Instalada antes de qualquer handler: envolve `ipcMain.handle`/`handleOnce`/`on`/`once` uma única vez, sem exigir
  mudança nos features.
- Cada chamada só é atendida se vier do **frame principal** de uma **BrowserWindow do Hangar** cuja URL seja a do
  nosso renderer (o `index.html` do build ou `ELECTRON_RENDERER_URL` em dev).
- Webviews, iframes (artifacts), janelas que navegaram para outro lugar e frames destruídos são recusados, com uma
  linha `[hangar] IPC recusado: …` no log.
- Testado: com o preload injetado de propósito num webview (cópia de teste), `store:list` e `settings:providersList`
  feitos de dentro dele foram recusados.

### 3. Navegação, popups, webviews e permissões (`installWebContentsHardening`, em `core/window.ts`)

- Janelas do app não navegam para fora do renderer (`will-navigate`/`will-redirect`). Links externos vão para o
  navegador do sistema por `openExternalLink`: `http`/`https` direto, `mailto:` só depois de confirmação, qualquer
  outro protocolo (`file:`, `ms-settings:`, `javascript:`…) é recusado e registrado. Popups (`window.open`) nunca
  criam janelas.
- `will-attach-webview` remove o preload e força `nodeIntegration: false`, `contextIsolation`, `sandbox`,
  `webSecurity` e a partição `persist:hangar-browser`; recusa `src` que não seja `http(s)`/`about:blank`. O feature
  preview aplica as mesmas regras, mais as dele: popups viram abas internas, downloads sempre com "salvar como" e
  permissões negadas na partição do navegador.
- Handler de permissões padrão-negar na sessão principal: só `clipboard-sanitized-write` (botões copiar) e
  `fullscreen` (player Motion), e só para o próprio renderer. Iframes de origem opaca não recebem nada.
- Artifacts HTML/Mermaid rodam em `<iframe sandbox="allow-scripts">`, com origem opaca, sem acesso ao `window.hangar`
  da página e recusados pela guarda de IPC.

### 4. Permissões do Claude Code (`engine/runner.ts`)

- `allowDangerouslySkipPermissions` só vai na query de uma sessão que **começa** em "Ignorar permissões".
- Entrar nesse modo, ou sair dele, no meio da sessão reinicia o processo do Claude Code com `resume`: a conversa
  continua, mas a capacidade não sobrevive à escolha. Durante uma geração, o reinício acontece ao fim da rodada.
- Os pedidos de permissão dos demais modos passam pelo cartão de permissão do chat.

### 5. Harness do Lab (`lab/exec.ts`)

- Antes de aplicar o harness vencedor no projeto, o main compara as "superfícies executáveis" com o harness atual:
  - comandos em `.claude/settings.json` (hooks, `statusLine`, `apiKeyHelper`, helpers AWS/OTel);
  - regras `permissions.allow` novas, `defaultMode`, servidores MCP do projeto e `env`;
  - arquivos em `.claude/scripts/**` e scripts de skills;
  - comandos `!` embutidos em comandos e skills.
- `lab:adoptReview` devolve a lista e uma impressão digital. `lab:adopt(…, apply=true)` **recusa** sem
  `confirmExec` igual a essa impressão: a UI só a envia depois de o usuário marcar "Revisei a lista e confio nesses
  comandos e arquivos".
- Rodadas manuais fazem o mesmo antes de rodar (`lab:createReview` + `confirmExec` em `lab:create`), porque os hooks
  das variantes executam nos worktrees da rodada.
- Remoções aparecem na lista, mas não exigem confirmação.

### 6. Segredos de provedor (`settings/providers.ts`)

- Perfis sem segredo em `providers.json`. Segredos cifrados com `safeStorage` (DPAPI no Windows) em
  `providers.secrets.json`, pelas APIs assíncronas (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
  `decryptStringAsync`, recifrando quando o sistema pede).
- Os segredos são decifrados uma vez, na inicialização, para um cache em memória, e o app só abre janelas depois disso
  (`providersReady`). Assim `resolveProviderLaunch` continua síncrono.
- Segredos nunca voltam ao renderer (só `hasSecret`) e são mascarados em erros, cartões e transcrições.
- Sem criptografia disponível, o Hangar se recusa a salvar chaves.

## Fuses do Electron (para o agente release)

Aplicar no pacote com `@electron/fuses` (`FuseV1Options`), com `strictlyRequireAllFuses: true`:

| Fuse                                    | Valor                   | Por quê                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunAsNode`                             | **false**               | Impede usar o `Hangar.exe` como `node` via `ELECTRON_RUN_AS_NODE`. Nada no app depende disso: o Claude Code é um binário nativo, e o terminal e o git já limpam essa variável                                         |
| `EnableNodeOptionsEnvironmentVariable`  | **false**               | Ignora `NODE_OPTIONS` (injeção de `--require`)                                                                                                                                                                        |
| `EnableNodeCliInspectArguments`         | **false**               | Ignora `--inspect`/`--inspect-brk` no executável empacotado                                                                                                                                                           |
| `EnableCookieEncryption`                | **true**                | Cookies da partição do navegador cifrados no disco                                                                                                                                                                    |
| `EnableEmbeddedAsarIntegrityValidation` | **true**                | Valida o hash do `app.asar`                                                                                                                                                                                           |
| `OnlyLoadAppFromAsar`                   | **true**                | Só carrega o app de dentro do `app.asar` (o `node-pty` e o binário do SDK ficam em `app.asar.unpacked`, que continua funcionando)                                                                                     |
| `LoadBrowserProcessSpecificV8Snapshot`  | false                   | Não usamos snapshot próprio                                                                                                                                                                                           |
| `GrantFileProtocolExtraPrivileges`      | **true (por enquanto)** | O renderer é carregado por `file://` e usa `<script type="module" crossorigin>`; sem esses privilégios ele não carrega. Para desligar, servir o renderer por um protocolo próprio (`protocol.handle('app', …)`) antes |

## Riscos conhecidos

- As rodadas **automáticas** do Lab rodam harnesses escritos pelo próprio Claude (proponentes) nos worktrees sem
  confirmação prévia por variante. A adoção continua exigindo confirmação, mas hooks de uma variante proposta podem
  executar durante a rodada. Mitigação futura: proibir hooks/scripts nas propostas ou exigir confirmação por estágio.
- `openExternal` de artifacts HTML/SVG (preview) abre o arquivo local no navegador padrão (`file://`). É conteúdo do
  agente com origem de arquivo; preferir abrir só com confirmação ou pelo servidor de artifacts.
- O modo "Ignorar permissões" é, por definição, execução sem pergunta. A camada aqui só garante que ele não vaze para
  outros modos nem para outras sessões.
