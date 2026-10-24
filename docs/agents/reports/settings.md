# Relatório — feature `settings`

## O que foi feito

### Main (`src/main/features/settings/`)
- `index.ts` — registra todos os handlers IPC, aplica `nativeTheme.themeSource` no boot e a cada `store:changed` de `settings`, inicia agendamentos, bandeja e notificações; `dispose()` limpa tudo.
- `cli.ts` — localiza o `claude`: usa o override `settings().claudeExecutablePath`; se não houver, roda `where.exe claude`, prioriza `.exe` > `.cmd`, com fallback para `~/.local/bin/claude.exe`. Roda subcomandos com `execFile` (shim `.cmd` passa por shell com aspas). Expõe `claude --version` e `claude auth status --json` (logado, método, assinatura, e-mail, org).
- `mcp.ts` — `claude mcp list` (não tem `--json`: faço parse da saída `nome: alvo (HTTP) - ✔ status`), com escopo e nomes de env/headers lidos **só para leitura** de `~/.claude.json` (user + `projects[cwd]` = local) e `<cwd>/.mcp.json` (project). Servidores `claude.ai …` aparecem com escopo `claude.ai` e não podem ser removidos. Adicionar usa `claude mcp add-json -s <escopo> <nome> <json>`, que evita os problemas das flags variádicas `-e`/`-H` de `mcp add`. Remover: `claude mcp remove <nome> -s <escopo>`. Detalhes: `claude mcp get`.
- `extensions.ts` — skills em `~/.claude/skills/*/SKILL.md` e `~/.claude/skills/synced/<bucket>/*/SKILL.md` (sincronizadas do claude.ai), com parser simples de frontmatter (inclui blocos `|`/`>`). Plugins a partir de `~/.claude/plugins/installed_plugins.json` (v1 e v2), com descrição de `.claude-plugin/plugin.json` e estado de `enabledPlugins` em `~/.claude/settings.json`.
- `schedules.ts` — CRUD em `<userData>/hangar-data/settings/schedules.json`, agendamento com `node-cron` (`noOverlap`), validação de cron com as 3 próximas execuções. Ao disparar (cron ou "Rodar agora"): cria uma `Session` em `db('sessions')` (título `"<nome> · dd/mm, hh:mm"`, modelo da tarefa ou padrão, esforço e modo de permissão padrão ou da tarefa) e chama `sendPrompt` de `engine/api`. O resultado vem de `session:turn-ended` (ou erro se `sendPrompt` falhar). Guarda as últimas 20 execuções; execuções que ficaram "em execução" quando o app fechou viram erro no próximo boot.
- `tray.ts` — notificações nativas para `session:turn-ended` ("<título> terminou") e `session:needs-input` ("<título> precisa de você"), só se `settings().notifications` e a janela não estiver focada; o clique mostra/foca a janela e emite `settings:event:focusSession`. Ícone de bandeja desenhado em código (bitmap BGRA 16/24/32 px, quadrado na cor de destaque com um "H"), menu Mostrar Hangar / Nova sessão / Sair; clique no ícone mostra a janela.

### Shared (`src/shared/features/settings.ts`)
Canais `settings:*` e tipos (`CliInfo`, `AuthStatus`, `McpServer`, `McpAddInput`, `SkillInfo`, `PluginInfo`, `ScheduledTask`, `ScheduleRun`, `CronCheck`, `AppInfo`). Eventos: `settings:event:focusSession`, `settings:event:newSession` (menu da bandeja), `settings:event:schedulesChanged`.

### Renderer (`src/renderer/src/features/settings/`)
- `SettingsView` — tela cheia com navegação lateral, Esc fecha, lembra a última seção:
  - **Geral**: tema (Sistema/Claro/Escuro; muda o app na hora), notificações (liga/desliga + "Testar"), modelo/esforço/modo de permissão padrão, executável do `claude` (detectado, override, "Procurar…", versão) e status do login ("Conectado com a assinatura (max)" ou instrução para rodar `claude` e fazer `/login`).
  - **Servidores MCP**: pasta de projeto opcional, lista com status (traduzido para PT-BR), escopo e transporte, Detalhes (`mcp get`), Remover, formulário de adição stdio (comando, args, env) e HTTP/SSE (URL, cabeçalhos) nos escopos usuário/local/projeto.
  - **Skills e plugins**: lista filtrável, abrir pasta (de cada item e das pastas raiz). Só leitura.
  - **Tarefas agendadas**: lista com liga/desliga, cron, última/próxima execução, histórico (com "abrir sessão"), Rodar agora, Editar, Excluir; formulário com modelos de cron e validação ao vivo.
  - **Atalhos** e **Sobre** (versões, pasta de dados com botão abrir).
- `CommandPalette` — Ctrl+K abre/fecha; busca fuzzy (sem acentos) em ações e sessões; setas, Enter, Esc, mouse. Ações: Nova sessão, Abrir configurações, Alternar sidebar, Abrir painel (Terminal/Changes/Files/Browser/Artifacts), Alternar tema, Importar sessões do Claude Code (dispara `OPEN_IMPORT_EVENT`, a constante que o feature sessions exporta para isso). Registra os atalhos globais Ctrl+K, Ctrl+, e Ctrl+` (fase de captura, para o xterm não engolir; Ctrl+` usa `e.code === 'Backquote'`, que funciona no ABNT2). Trata `focusSession` e `newSession`.
- Como o `App` desmonta a raiz (inclusive o `CommandPalette`) quando as configurações estão abertas, o `SettingsView` monta seu próprio `<CommandPalette />`. Os dois nunca ficam montados ao mesmo tempo, então Ctrl+K e os eventos da bandeja/notificação funcionam também dentro das configurações.

## Verificação
- `npm run typecheck` sem erros (projeto inteiro, no momento do teste).
- `npm run build` passa.
- App rodado a partir de uma cópia do build, com `--user-data-dir` isolado na scratchpad (outro agente usava a porta 9333 e o `out/` estava sendo reconstruído em paralelo), e dirigido via CDP:
  - tema Claro/Escuro aplicado na hora (`data-theme` muda; `nativeTheme` acompanha);
  - `claude --version` = 2.1.307 e login "Conectado com a assinatura (max)";
  - MCP: listar (7 servidores com status), adicionar stdio no escopo projeto e HTTP no escopo local numa pasta temporária, `mcp get`, remover os dois. Tudo pelo CLI;
  - tarefa agendada "Rodar agora" → sessão criada, prompt enviado pelo engine, resposta "OK", histórico marcado como Sucesso, próxima execução calculada;
  - paleta: Ctrl+K abre com foco, busca, setas, Enter seleciona a sessão, Esc fecha; Ctrl+` abre o terminal da sessão; Ctrl+, abre as configurações;
  - `settings:testNotification` retorna `true` (não consegui ver o toast pelo CDP, veja os riscos).
- Instâncias que eu abri foram encerradas.

## Como testar
1. `npm run dev`. Ctrl+, abre as configurações → Geral: troque o tema e confira o app inteiro.
2. Servidores MCP: escolha uma pasta, adicione `teste` stdio com comando `node` e args `-e 1` no escopo Projeto → aparece como "Aguardando aprovação" → Remover.
3. Tarefas agendadas → Nova tarefa (pasta qualquer, prompt "Responda apenas OK", modelo `haiku`) → Salvar → Rodar agora → "abrir sessão" no histórico.
4. Ctrl+K: digite parte do título de uma sessão, use as setas e Enter.
5. Com uma sessão rodando, tire o foco da janela: ao terminar, aparece "<título> terminou"; o clique foca a sessão.

## O que ficou faltando
- MCP: ligar/desligar e ver log (o CLI não tem comando direto; o FEATURES.md lista isso). Login OAuth de servidor (`claude mcp login`) não foi exposto.
- Hooks (P2) e Quick Entry por atalho global (P2) não foram feitos.
- Tarefas agendadas só rodam com o Hangar aberto; execuções perdidas com o app fechado não são recuperadas.

## Pedidos ao chief
1. **Palette quando as configurações estão abertas**: hoje o `App.tsx` retorna só `<SettingsView/>` e desmonta o `<CommandPalette/>`, por isso monto a paleta também dentro do `SettingsView`. Se o `App` passar a renderizar `<CommandPalette />` sempre (fora do `if (settingsOpen)`), me avise para eu remover o da `SettingsView`. Com os dois montados, o Ctrl+K abriria e fecharia na mesma tecla.
2. **Contrato**: uso `OPEN_IMPORT_EVENT` de `src/shared/features/sessions.ts`, que o sessions criou para a paleta. Vale incluir esse evento na lista "Contratos entre features" do RULES.md.
3. **Notificações no Windows em dev**: o `app.setAppUserModelId('dev.hangar.app')` exige um atalho no Menu Iniciar com esse AUMID para o toast aparecer de forma confiável. O instalador (electron-builder/squirrel) cria esse atalho; rodando sem instalar, o toast pode não aparecer. Considere usar o mesmo AUMID no empacotamento.
4. **Ícone da janela (opcional)**: se quiser o mesmo ícone na janela/barra de tarefas, posso exportar o `nativeImage` gerado em `tray.ts` (por exemplo `appIcon()`) para o `src/main/index.ts` passar em `new BrowserWindow({ icon })`.
5. **Minimizar para a bandeja (opcional)**: com `window-all-closed → app.quit()`, fechar a janela encerra o app e as tarefas agendadas. Para continuarem rodando com a janela fechada, o `index.ts` precisaria esconder a janela no `close` em vez de sair (o menu "Sair" da bandeja já chama `app.quit()`).
6. **Aviso para os outros features**: no Chromium 156 do Electron 45, `element.scrollTo({...})` (e a família de scroll) **retorna uma Promise**. Um `useEffect(() => ref.current?.scrollTo(...))` devolve essa Promise como cleanup e o React quebra a árvore inteira ao desmontar (`destroy_ is not a function`, tela em branco). Corrigi no meu código. Vale revisar effects de corpo-expressão em outros features, por exemplo `FilesPanel.tsx:122` `useEffect(() => load(), …)` e `TerminalPanel.tsx:127` `useEffect(() => startTerminals(), [])`: se essas funções retornarem algo que não seja função, o mesmo crash acontece.

## Riscos conhecidos
- O parse do `claude mcp list` depende do formato de texto do CLI (não existe `--json`). Se não houver parse, a UI mostra a saída crua.
- Tarefas criadas com modo de permissão "Perguntar" param no primeiro pedido de permissão. Nesse caso chega a notificação "precisa de você", mas a tarefa fica "Em execução" até a sessão terminar.
- As sessões de tarefas agendadas são criadas direto em `db('sessions')`, como pede o brief, e não via `sessions:create`. Se o sessions passar a exigir campos extras na criação, é preciso alinhar.
- Os detalhes de MCP (`claude mcp get`) mostram valores de env/cabeçalhos como o CLI imprime. A lista mostra só os nomes.
