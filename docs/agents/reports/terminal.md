# Relatório — terminal

## Resumo

Terminal integrado completo: PTY nativo funcionando no Electron 45, várias abas por sessão (PowerShell, cmd, Git Bash,
pwsh quando instalado), na pasta da sessão, com tema claro/escuro, copiar/colar, redimensionamento e terminais que
sobrevivem à troca de aba do painel, ao fechamento do painel, à troca de sessão e até a um reload do renderer.

## PTY nativo (node-pty) — resolvido sem rebuild e sem trocar de pacote

- **Causa da falha do `electron-rebuild`:** a variável de ambiente `NoDefaultCurrentDirectoryInExePath=1` está definida
  na máquina (herdada pelo shell do Claude Code). O `winpty.gyp` do node-pty executa `cmd /c "cd shared && GetCommitHash.bat"`,
  e com essa variável o `cmd` não procura executáveis no diretório atual, então dá `'GetCommitHash.bat' não é reconhecido…`
  e o gyp aborta. Não tem relação com VS 2026 nem com Python 3.14.
- **Por que não precisa de rebuild:** o `node-pty@1.1.0` é N-API (node-addon-api) e já traz binários pré-compilados em
  `node_modules/node-pty/prebuilds/win32-x64` (incluindo `conpty.dll`/`OpenConsole.exe`). N-API é ABI-estável, então o mesmo
  binário carrega no Electron 45 (Node 24.22, ABI 150) sem recompilar.
- **Prova:** um script carregado como processo main do Electron 45 fez `require('node-pty')`, abriu `powershell.exe` e
  recebeu a saída (`PTY-OK C:\…\hangar`, exit 0). Depois disso o app inteiro foi exercitado (ver "Como testar").
- **Nenhum `npm install`/`uninstall` foi feito.** O `electron.vite.config.ts` continua correto (`node-pty` como external).
- Sobrou um `node_modules/node-pty/build/config.gypi` da tentativa de rebuild; é inofensivo (o loader procura
  `build/Release` e cai para `prebuilds/`).

## O que foi feito

### Shared — `src/shared/features/terminal.ts`
Canais `terminal:create | write | resize | kill | rename | list | shells` e eventos `terminal:event:created | data | exit`,
mais os tipos `ShellInfo`, `CreateTerminalOptions`, `TerminalInfo`, `TerminalSnapshot`, `TerminalDataEvent` (com `seq`)
e `TerminalExitEvent` (com `killed`).

### Main — `src/main/features/terminal/`
- `shells.ts`: detecta pwsh (PATH / Program Files), Windows PowerShell, cmd (`ComSpec`) e Git Bash (locais padrão e
  relativo ao `git.exe` do PATH; nunca o `System32\bash.exe` do WSL). Em macOS/Linux: `$SHELL`, zsh, bash, sh.
- `manager.ts`:
  - `node-pty` carregado sob demanda (`import()` dinâmico): se o módulo nativo falhar, só o terminal fica indisponível
    (erro aparece no painel), o app não cai.
  - Saída agrupada a cada ~8 ms num único timer para todos os PTYs; cada lote leva um `seq` incremental.
  - Guarda os últimos ~256 KB de saída por PTY para reconstruir a tela após reload do renderer (`terminal:list` devolve
    `buffer` + `seq`; o renderer descarta eventos com `seq` já incluído no snapshot, sem duplicar nem perder saída).
  - cwd inexistente cai para a home; `ELECTRON_*` removidas do ambiente do shell; `TERM_PROGRAM=Hangar`,
    `COLORTERM=truecolor`; `CHERE_INVOKING=1` no Git Bash para respeitar o cwd.
  - O evento `created` é enviado antes da resposta do invoke e antes de qualquer saída.
- `index.ts`: registra os handlers; escuta `store:changed` no `bus` e mata os PTYs de sessões que não existem mais;
  `dispose()` mata todos.
- `api.ts`: `runInNewTerminal(sessionId, cwd, command): Promise<string>` — abre um terminal com o shell padrão, digita o
  comando e retorna o id; o renderer adota a aba automaticamente pelo evento `created`.

### Renderer — `src/renderer/src/features/terminal/`
- `terminals.ts`: registro em nível de módulo das instâncias xterm (fora do React), store zustand das abas
  (`useTerminals`), ligação de IPC uma única vez por renderer e sincronização inicial com `terminal:list`.
- `TerminalPanel.tsx` (export mantido em `index.tsx`):
  - Abas: nova (`+`), fechar (`×` ou botão do meio), renomear com duplo clique (Enter/Esc), seletor de shell (`▾`, lembra
    o último shell escolhido como padrão).
  - Abre um terminal automaticamente na primeira vez que o painel aparece para a sessão (só depois de sincronizar com o
    main, para não duplicar após reload). Fechar a última aba não reabre sozinho; mostra "Novo terminal".
  - O DOM do xterm é movido para o container ativo e retirado ao desmontar; o xterm continua recebendo dados em segundo
    plano, então nada se perde ao fechar o painel, trocar de aba do painel ou trocar de sessão.
  - `ResizeObserver` + `FitAddon` (ignora quando o painel está oculto, 0×0), propagando cols/rows para o PTY.
  - Ctrl+C copia quando há seleção (senão manda SIGINT); Ctrl+V cola; Ctrl+Shift+C/V também; botão direito copia a
    seleção ou cola (estilo Windows Terminal). Links abrem com `api.openExternal`.
  - Saída com código 0 (ex.: `exit`) ou PTY morto pelo app fecha a aba; código ≠ 0 mantém a aba riscada com
    "[Processo encerrado com código N]".
  - Foco vai para o terminal ao abrir o painel ou trocar de aba, mas não ao trocar de sessão (para não roubar o foco do chat).
- `theme.ts`: tema derivado das variáveis CSS (`--bg-sunken`, `--text`, `--accent`, `--text-muted`) com paletas ANSI
  para claro e escuro; um `MutationObserver` em `data-theme` atualiza todos os terminais ao trocar o tema. Fonte `--mono`.
- `terminal.module.css`: estilos com as variáveis do tema.

## Verificação

- `npm run typecheck`: sem erros. `npm run build`: passa.
- Teste no Electron real: como o renderer de dev estava quebrando/recarregando por arquivos em andamento de outros features
  (ex.: `sessions.module.css` ausente naquele momento), rodei o **main real** (`out/main`, com todos os features) com
  `ELECTRON_RENDERER_URL` apontando para uma página de teste temporária (na pasta de rascunho, fora do repo) que monta só
  o `TerminalPanel`, e dirigi pelo DevTools Protocol. Verificado:
  - criação via IPC, evento `created` antes dos dados, lotes de saída, `rename`, `list`, `resize` (PowerShell reportou 55
    e 74 colunas conforme a largura do painel);
  - abas de PowerShell na pasta da sessão (`$PWD` = cwd da sessão), segunda aba pelo `+`, cmd e Git Bash pelo seletor
    (Git Bash abriu no cwd certo);
  - trocar de sessão A→B→A e desmontar/remontar o painel mantém o conteúdo;
  - tema escuro/claro aplicado;
  - reload do renderer: as 3 abas voltaram com o conteúdo reconstruído;
  - teclas reais: texto + Enter executa; Ctrl+C sem seleção interrompe um `ping`;
  - `exit 3` no cmd mantém a aba com a mensagem; `exit` no Git Bash fecha a aba;
  - apagar a sessão do store mata os PTYs dela e remove as abas; matar um PTY também encerra os processos filhos
    (um `ping` longo morreu junto).
  - Todos os processos de teste foram encerrados e as sessões de teste (`tt-*`) removidas do store.

## Como testar

1. `npm run dev`, abra/crie uma sessão e clique em **Terminal** na barra superior: um PowerShell abre na pasta da sessão.
2. `+` abre outra aba; `▾` escolhe outro shell; duplo clique no nome renomeia; `×` fecha.
3. Arraste a borda do painel: o terminal se ajusta (`$Host.UI.RawUI.WindowSize.Width` muda).
4. Troque para Changes/Browser e volte, feche o painel e reabra, troque de sessão e volte: os terminais continuam lá.
5. Troque o tema em Configurações: as cores do terminal acompanham.
6. Ctrl+R no app (reload): as abas voltam com o conteúdo recente.

## Pedidos ao chief

- Nenhuma mudança obrigatória em arquivos do chief. O pacote continua `node-pty` (não troquei de fork).
- Recomendo remover ou ajustar o script `"rebuild": "electron-rebuild -f -w node-pty"` do `package.json`: ele não é
  necessário (prebuilds N-API) e falha nesta máquina por causa de `NoDefaultCurrentDirectoryInExePath=1`. Se algum dia for
  preciso compilar, rode com a variável removida (PowerShell: `$env:NoDefaultCurrentDirectoryInExePath=$null; npx electron-rebuild -f -w node-pty`).
  Atenção: um build local em `build/Release` passa a ter prioridade sobre os prebuilds.
- Empacotamento (quando houver electron-builder): `node-pty` precisa ficar fora do asar
  (`asarUnpack: ["node_modules/node-pty/**"]`), por causa dos `.node`, `conpty.dll`, `OpenConsole.exe` e do helper forkado.
- Opcional: documentar em `src/main/core/bus.ts` que o terminal escuta `store:changed` (não emite eventos novos).

## Riscos conhecidos

- Ao matar um PTY no Windows, o node-pty imprime no stderr `Error: AttachConsole failed` vindo de um processo auxiliar
  (`conpty_console_list_agent`). É uma corrida interna do node-pty (o console é fechado antes de o auxiliar se anexar);
  é só ruído no log — os processos filhos são encerrados mesmo assim (verificado).
- Atalhos globais de outros features (ex.: Ctrl+K, Ctrl+B) registrados em `window` podem disparar enquanto o terminal tem
  foco, e o xterm também recebe a tecla. Se incomodar, os atalhos globais podem ignorar eventos cujo alvo esteja dentro de
  `.xterm`.
- A reconstrução após reload reproduz a saída bruta (até 256 KB); se a largura mudou, linhas antigas podem aparecer um
  pouco desalinhadas. Reload completo do app (fechar e abrir) não preserva terminais — os PTYs morrem com o processo.
- `navigator.clipboard` depende de a janela estar focada (sempre verdade ao usar o teclado no terminal).
- O shell "padrão" do `+` é o último escolhido no `▾` (guardado em `localStorage`); se ele deixar de existir, cai para o
  primeiro detectado.
