# Missão: terminal (terminal integrado)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `terminal`.
Suas pastas: `src/main/features/terminal/`, `src/renderer/src/features/terminal/`, `src/shared/features/terminal.ts`.

## Primeiro: fazer o PTY nativo funcionar no Electron 45

`npx electron-rebuild -f -w node-pty` falhou (node-gyp; a máquina tem "Ferramentas de Build do Visual Studio 2026" e
Python 3.14). Descubra a causa (`npx electron-rebuild -f -w node-pty 2>&1`) e resolva. Ordem de preferência:
1. Fazer o rebuild do `node-pty` passar (ex.: variáveis `GYP_MSVS_VERSION`/`npm_config_msvs_version`, versão do node-gyp).
2. Trocar por um fork com binários pré-compilados compatíveis com Electron (ex.: `@lydell/node-pty`) — **você é o único
   agente autorizado a rodar `npm install`/`npm uninstall`, e só para o pacote de PTY**.
Prove que funciona carregando o módulo no processo main do Electron. O `electron.vite.config.ts` marca `node-pty` como
external; se trocar de pacote, peça ao chief para ajustar (e importe com o nome novo).

## Main

- IPC: `terminal:create` ({ sessionId, cwd, shell?, cols, rows }) → { id }, `terminal:write`, `terminal:resize`,
  `terminal:kill`, `terminal:list` (sessionId), `terminal:shells` (detecta pwsh, powershell, cmd e Git Bash).
  Eventos: `terminal:event:data` ({ id, data }) e `terminal:event:exit` ({ id, code }).
- Agrupe as escritas de dados (~8 ms) para não inundar o IPC. Mate todos os PTYs em `dispose()` e quando a sessão for
  removida do store (escute `store:changed` no `bus` e confira se a sessão ainda existe).
- Exporte `src/main/features/terminal/api.ts` com `runInNewTerminal(sessionId, cwd, command): Promise<string>` para uso
  futuro de outros features.

## Renderer — `TerminalPanel({ session })`

- Abas de terminal (nova, fechar, renomear com duplo clique, seletor de shell), cwd = `session.worktree?.path ?? session.cwd`.
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` (links abrem com `api.openExternal`). Tema derivado das
  variáveis CSS, atualizado ao trocar claro/escuro; fonte `var(--mono)`.
- Redimensiona com o painel (ResizeObserver + fit). Copiar com seleção/Ctrl+C quando houver seleção; colar com Ctrl+V.
- Os terminais sobrevivem à troca de aba do painel (o SidePanel mantém este componente montado) e à troca de sessão:
  guarde os PTYs por sessão e recoloque os buffers ao voltar.
- Abra um terminal automaticamente na primeira vez que o painel aparecer para a sessão.

## Pronto quando

O PTY carrega no Electron, dá para abrir várias abas de PowerShell na pasta da sessão, rodar comandos, redimensionar e
trocar de sessão sem perder os terminais.
