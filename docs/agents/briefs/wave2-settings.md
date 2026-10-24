# Segunda onda: settings (MCP ligar/desligar e log, Quick Entry, bandeja)

As regras de `docs/agents/RULES.md` continuam valendo. Suas pastas são as mesmas da primeira onda.
O chief já mudou o core para esta onda — leia antes: `git log -1 -p -- src/main src/shared/contracts.ts src/renderer/src/main.tsx`.

O que já existe:
- `Settings.minimizeToTray` (padrão `true`) e `Settings.quickEntryShortcut` (padrão `CommandOrControl+Alt+Space`) em
  `src/shared/contracts.ts`.
- `src/main/index.ts` já esconde a janela no `close` quando `minimizeToTray` está ligado e não sai em
  `window-all-closed`. `isQuitting()`/`markQuitting()` em `src/main/core/window.ts`.
- `FeatureContext.showMainWindow()` mostra/recria a janela principal.
- `loadRenderer(win, 'quick-entry')` e `rendererWebPreferences()` em `src/main/core/window.ts`. O renderer mostra o export
  `QuickEntry` de `src/renderer/src/features/settings/index.tsx` quando o hash é `#quick-entry` (hoje é um stub).

## 1. MCP: ligar/desligar e log

- Ligar/desligar por servidor. O CLI não tem esse comando: pesquise o mecanismo suportado pelo Claude Code
  (por exemplo `disabledMcpjsonServers`/`enabledMcpjsonServers` nas settings do projeto, ou `disabledMcpServers`;
  confira na documentação oficial, `https://code.claude.com/docs/en/mcp` e `/settings`). Para servidores de usuário sem
  mecanismo de desligar, implemente "desligar" guardando a configuração (`claude mcp get`) no Hangar e removendo com
  `claude mcp remove`; "ligar" re-adiciona com `claude mcp add-json`. Deixe claro na UI qual dos dois foi usado.
- Log: mostre os logs MCP do Claude Code por servidor (procure onde o CLI grava; no Windows costuma ser em
  `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<projeto>\mcp-logs-<servidor>\*.txt` — confirme). Visualizador com o arquivo
  mais recente, recarregar e abrir pasta.
- Mostre também os servidores que vêm do `.mcp.json` do projeto.

## 2. Quick Entry

- Atalho global (`globalShortcut`) com o accelerator de `settings().quickEntryShortcut`; re-registre quando mudar;
  mostre erro na UI se o registro falhar (atalho em uso).
- Janela pequena sem moldura, sempre no topo, centralizada no monitor do cursor, que some ao perder o foco
  (`frame: false`, `alwaysOnTop`, `skipTaskbar`, `show: false`, `rendererWebPreferences()`, `loadRenderer(win, 'quick-entry')`).
  Reaproveite a janela (esconda em vez de destruir).
- `QuickEntry`: campo de prompt grande, seletor de pasta (pastas fixadas/recentes), Enter cria a sessão
  (`sessions:create`) e envia (`engine:send`); depois esconde a janela, chama `showMainWindow()` e seleciona a sessão
  (reuse `settings:event:focusSession`). Esc fecha. Tema claro/escuro igual ao app.
- Em Configurações → Geral: campo para gravar o atalho (capturar teclas), ligar/desligar.

## 3. Bandeja

- Em Configurações → Geral: "Minimizar para a bandeja ao fechar" (`minimizeToTray`).
- Menu da bandeja: Mostrar Hangar (usa `showMainWindow`), Quick Entry, Nova sessão, Sair (chame `markQuitting()` antes de
  `app.quit()`). Clique simples no ícone mostra/esconde a janela. Na primeira vez que a janela for para a bandeja,
  mostre uma notificação avisando que o Hangar continua rodando ali.
- Exporte de `tray.ts` uma função `appIcon(): NativeImage` e peça ao chief no relatório para usá-la como ícone da janela.

## Pronto quando

Desligar/ligar um MCP de teste funciona e é refletido em `claude mcp list`; o log abre; o atalho global abre o Quick Entry,
que cria uma sessão e foca a janela principal; fechar a janela manda para a bandeja e "Sair" encerra. Use um MCP de teste
que você mesmo adicione e remova no fim; não mexa nos servidores MCP existentes do usuário. Teste o app com
`--user-data-dir` isolado e uma porta de depuração livre (não use 9333 nem 19888). Relatório em
`docs/agents/reports/wave2-settings.md`; responda só `PRONTO: wave2-settings`.
