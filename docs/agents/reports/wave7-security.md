# Relatório — security (sétima onda)

## O que foi feito

1. **Sandbox do renderer** (`core/window.ts`): `rendererWebPreferences` passou a forçar `sandbox: true`,
   `contextIsolation`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false` e `webSecurity`, e essas chaves
   não podem ser sobrescritas por quem chama. Vale para a janela principal e para o Quick Entry. O preload já só usava
   `contextBridge`/`ipcRenderer`/`webUtils`/`process.platform`; o build gera só `require("electron")`. Documentei a
   restrição no topo do preload.
2. **Guarda de IPC** (`core/ipcGuard.ts`, instalada no topo do `index.ts`, antes de qualquer handler):
   - Envolve `ipcMain.handle`/`handleOnce`/`on`/`once` (com `removeListener`/`off` coerentes) uma única vez.
   - Só atende o frame principal de uma BrowserWindow do Hangar cuja URL seja o `index.html` do build (ou a origem
     de `ELECTRON_RENDERER_URL` em dev).
   - O resto é recusado com `[hangar] IPC recusado: "<canal>" de <tipo> em <url>`.
   - Nenhum feature precisou mudar.
3. **Navegação, webviews e permissões** (`installWebContentsHardening`, em `core/window.ts`):
   - Janelas não navegam para fora do renderer. Popups são negados.
   - Links passam por `openExternalLink`: `http(s)` direto, `mailto:` com diálogo de confirmação, outros protocolos
     recusados e logados. Substitui o `setWindowOpenHandler` antigo do `index.ts`.
   - `will-attach-webview` força sem preload, `nodeIntegration: false`, sandbox, contextIsolation, webSecurity e a
     partição `persist:hangar-browser`, e recusa `src` que não seja http(s)/about:blank. É uma camada além da que o
     preview já tem.
   - Handler de permissões padrão-negar na sessão principal: só `clipboard-sanitized-write` e `fullscreen`, e só para
     o renderer.
   - Auditoria de `shell.openExternal`:
     - o handler de links do `index.ts` foi substituído (agora com `mailto:` confirmado);
     - `core/ipc.ts` já só aceita http(s) (`mailto:` é recusado; não está nas minhas exceções);
     - `preview/artifacts.ts` abre artifacts HTML/SVG por `file://` (ver "Pedidos").
4. **`allowDangerouslySkipPermissions`** (`engine/runner.ts`):
   - Só vai na query quando a sessão começa em `bypassPermissions`.
   - Entrar nesse modo, ou sair dele, no meio da sessão fecha o processo; a próxima mensagem retoma com `resume`.
     Durante uma geração, o fechamento acontece no fim da rodada, com aviso na transcrição. Sair do bypass aplica o
     novo modo na hora e depois reinicia, para a capacidade não sobrar no processo.
5. **Adoção no Lab** (`lab/exec.ts`, `rounds.ts`, `index.ts`, `labApi.ts`, `RoundDetail.tsx`, `NewRound.tsx`,
   `ExecWarning.tsx`; tipos no contrato do Lab):
   - `execChanges(base, next)` lista o que muda no que pode rodar: comandos em `.claude/settings.json` (hooks,
     `statusLine`, `apiKeyHelper`, helpers AWS/OTel), regras `permissions.allow` novas, `defaultMode`/diretórios/MCP do
     projeto, `env`, scripts em `.claude/scripts/**` e de skills, e comandos `!`…`` embutidos em markdown.
   - `lab:adoptReview` devolve a lista e uma impressão digital (sha256). `lab:adopt(roundId, true, confirmExec)`
     **recusa** sem a impressão certa.
   - Rodadas manuais: `lab:createReview` mostra o aviso por variante e `lab:create` recusa sem `confirmExec`.
   - A UI mostra o cartão de aviso; o botão só libera depois de marcar "Revisei a lista e confio nesses comandos e
     arquivos". Só remoções não exigem confirmação.
6. **`safeStorage` assíncrono** (`settings/providers.ts`):
   - `loadProviders()` decifra com `isAsyncEncryptionAvailable`/`decryptStringAsync`, recifrando quando
     `shouldReEncrypt`. `setProviderSecret` usa `encryptStringAsync`.
   - O `index.ts` aguarda `providersReady()` antes de criar a janela, então nenhuma sessão abre antes dos segredos
     estarem em memória, e `resolveProviderLaunch` continua síncrono.
   - Como `setProviderSecret` virou assíncrono, ele mesmo mascara os erros: o `guarded` do settings só pega erros
     síncronos.
7. **`docs/SECURITY.md`**: modelo de ameaças, as camadas e a tabela de **fuses** para o agente release.

## Como foi testado (app real, sandbox)
Cópia isolada da árvore inteira no scratchpad (build próprio), `--user-data-dir` isolado, portas 27531/27532,
repositório git temporário fora do repo, dirigido por CDP.
- **Sandbox**: nenhum processo de renderer com `--no-sandbox`; na página, `window.hangar` existe e
  `process`/`require` não; `platform` = `win32`.
- **Chat**: Haiku pela assinatura; ferramenta Write; botão "Copiar" → "Copiado" (permissão de clipboard concedida ao
  renderer).
- **Artifacts**: o HTML escrito pelo agente renderiza no iframe.
- **Terminal**: PowerShell respondeu `echo hangar-terminal-ok`.
- **Navegador**: `https://example.com` carregou; dentro do webview, `window.hangar`, `process` e `require` estão
  indefinidos.
- **Motion**: o exemplo abriu no player e desenha (cena "Números", 0:04/0:12).
- **Lab**:
  - Rodada sintética decidida, com vencedor contendo hook PowerShell + `Bash(*)` + `.claude/scripts/limpa.sh`.
  - `lab:adopt` sem confirmação e com confirmação errada foram **recusados**, e nada foi gravado.
  - Pela UI, o aviso listou os 3 itens; o botão ficou desabilitado até marcar a caixa; depois aplicou, sem executar o
    hook.
  - Rodada manual com script de skill e `!`git push --force``: `createReview` listou tudo e `lab:create` sem
    confirmação foi recusado.
- **Provedores**:
  - Segredo falso (`sk-test-hangar-0000`) salvo via `encryptStringAsync` (não aparece em claro no arquivo).
  - Depois de **reiniciar** o app, a sessão com esse perfil chegou ao gateway falso e voltou "credenciais recusadas
    (HTTP 401)", o que prova que o segredo foi decifrado na inicialização.
- **Bypass**:
  - Sessão em "Perguntar" trocada para "Ignorar permissões": o runner fechou e a próxima mensagem retomou (o Claude
    lembrou a palavra) e rodou `Remove-Item` sem pedir permissão.
  - De volta a "Perguntar": novo reinício, e o `Remove-Item README.md` pediu permissão (neguei; o arquivo ficou).
- **Navegação**: `location.href = 'file:///C:/Windows/win.ini'` não saiu do renderer.
  `window.open('file:…')`/`window.open('ms-settings:…')` foram negados e logados ("link externo recusado").
- **IPC a partir de webview** (prova por CDP):
  - Numa segunda cópia de teste injetei de propósito o preload no webview, para simular uma falha da 1ª camada.
  - Dentro do webview em `https://example.com`, `window.hangar.invoke('store:list')` e
    `invoke('settings:providersList')` foram **recusados**, com o log `[hangar] IPC recusado: "store:list" de webview
    em https://example.com/`.
  - A janela principal continuou atendida.

`npm run typecheck` e `npm run build` passam na árvore real.

**Observação do ambiente**: durante o teste, o gateway local do usuário (`localhost:8787`, configurado no
`~/.claude/settings.json`) respondia 502 (upstream 400), e até o `claude -p` puro falhava. Para seguir com o teste de
chat, só na cópia descartável apontei o endpoint oficial por uma variável de teste (`HANGAR_TEST_BASE_URL`, via
settings da query). Nenhuma chave foi usada além do login da assinatura, e o código real não tem esse desvio.

## Pedidos ao chief
1. **Preview** (`src/main/features/preview/artifacts.ts:178`): `shell.openExternal(pathToFileURL(artifact.path))` abre
   HTML/SVG do agente por `file://` no navegador padrão. Sugestão: pedir confirmação ou abrir pelo servidor de
   artifacts.
2. **Core** (`src/main/core/ipc.ts`): o canal `app:openExternal` pode usar `openExternalLink` de `core/window.ts`
   (http(s) direto, `mailto:` com confirmação), para todo o app seguir uma regra só. Hoje ele aceita só http(s), o
   que é seguro mas recusa `mailto:` em silêncio.
3. **Settings** (`settings/index.ts`): o `guarded` só mascara erros síncronos. Torná-lo `async` (`await fn()` dentro
   do try) protege os próximos handlers assíncronos; `setProviderSecret` já se protege sozinho.
4. **Lab automático**: variantes geradas pelos proponentes rodam nos worktrees sem confirmação por variante. A adoção
   continua protegida. Sugestão: proibir hooks/scripts nas propostas ou exigir confirmação por estágio.
5. **Release**: aplicar as fuses da tabela do `docs/SECURITY.md`. Atenção: `GrantFileProtocolExtraPrivileges`
   precisa ficar **ligada** enquanto o renderer for carregado por `file://` com `<script type="module" crossorigin>`.
6. **Contrato do Lab**: os tipos `ExecChange`/`ExecReview`/`VariantExecReview` e os canais
   `lab:adoptReview`/`lab:createReview` foram para `src/shared/features/lab.ts`, que é o contrato do próprio feature
   Lab. Entendi a exceção "pastas do lab (só o fluxo de adoção)" como incluindo esse arquivo; o resto do contrato não
   mudou.

## Riscos conhecidos
- O Quick Entry e o tray podem abrir antes de `providersReady()` se o atalho global for usado no primeiro instante da
  inicialização; os agendamentos (cron) também usam `resolveProviderLaunch` logo no registro do settings. A janela
  principal só abre depois.
- A guarda compara a URL do frame com o `index.html` do build; um build servido de outro lugar (ex.: protocolo
  próprio no futuro) precisa atualizar `isRendererUrl`.
- `execChanges` cobre os campos de comando conhecidos do `settings.json`; campos novos do Claude Code que executem
  comandos precisam entrar em `COMMAND_KEYS`.
- Limpeza: encerrei os apps de teste e o gateway falso, removi as cópias isoladas (junction desfeita antes; o
  `node_modules` real está intacto) e as sessões de teste em `~/.claude/projects`.
