# Missão: settings (configurações, MCP, skills, agendamentos, paleta, notificações)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `settings`.
Suas pastas: `src/main/features/settings/`, `src/renderer/src/features/settings/`, `src/shared/features/settings.ts`.

## SettingsView({ onClose })

Tela cheia com navegação lateral (Esc fecha):
- **Geral**: tema (sistema/claro/escuro → `settings().theme`; no main aplique também `nativeTheme.themeSource`),
  notificações, modelo/esforço/modo de permissão padrão, caminho do `claude` (auto-detectar no PATH, mostrar
  `claude --version`) e status do login (rode o comando de status de autenticação que o CLI oferecer — confira em
  `claude --help`; mostre "Conectado com a assinatura" ou instrução para rodar `claude` e fazer login).
- **Servidores MCP**: liste os servidores do usuário e do projeto (pasta escolhida). Prefira o próprio CLI
  (`claude mcp list`, `claude mcp add`, `claude mcp remove`, `claude mcp get`; confira a sintaxe em `claude mcp --help`)
  em vez de editar `~/.claude.json` à mão. Adicionar: stdio (comando, args, env) ou HTTP/SSE (URL, headers).
  Mostre status de conexão quando o CLI informar.
- **Skills e plugins**: liste `%USERPROFILE%\.claude\skills\*\SKILL.md` (nome e descrição do frontmatter) e os plugins
  instalados (procure em `%USERPROFILE%\.claude\plugins`); abrir pasta; só leitura nesta fase.
- **Tarefas agendadas**: CRUD de tarefas `{ id, name, cron, cwd, prompt, model?, enabled, lastRunAt?, lastResult? }`
  salvas em `<userData>/hangar-data/settings/schedules.json`. Agende com `node-cron`. Ao disparar: crie uma `Session`
  em `db('sessions')` (título = nome da tarefa + data) e chame `sendPrompt` de `src/main/features/engine/api.ts`.
  Botão "Rodar agora". Histórico das últimas execuções.
- **Atalhos**: tabela dos atalhos do app (Ctrl+K paleta, Ctrl+N nova sessão, Ctrl+B sidebar, Ctrl+, configurações,
  Ctrl+` terminal, Ctrl+Shift+↑/↓ trocar sessão).
- **Sobre**: versão do app, Electron, Node, pasta de dados (abrir).

## CommandPalette()

Montada uma vez na raiz. Ctrl+K abre (`useUi().setPaletteOpen`). Busca fuzzy simples em: sessões (selecionar), ações
(Nova sessão, Abrir configurações, Alternar sidebar, abrir cada aba do painel lateral, Alternar tema, Importar sessões).
Navegação por setas, Enter executa, Esc fecha. Também registre aqui os atalhos globais da janela Ctrl+, (configurações)
e Ctrl+` (abre o painel na aba terminal).

## Notificações e bandeja (main)

- Escute `session:turn-ended` e `session:needs-input` no bus; se `settings().notifications` e a janela não estiver focada,
  mostre `Notification` do Electron ("<título> terminou" / "<título> precisa de você"); clique foca a janela e seleciona
  a sessão (evento `settings:event:focusSession` → o renderer chama `useUi().selectSession`; trate isso dentro do
  `CommandPalette`, que está sempre montado).
- Ícone na bandeja com menu: Mostrar Hangar, Nova sessão, Sair. Gere o ícone em código (`nativeImage` a partir de um
  PNG/SVG pequeno embutido); nada de arquivos binários fora da sua pasta.

## Pronto quando

Trocar o tema muda o app inteiro na hora; dá para listar/adicionar/remover um servidor MCP pelo CLI; uma tarefa agendada
"Rodar agora" cria uma sessão e dispara o prompt; a paleta abre com Ctrl+K e navega; notificações aparecem com a janela
desfocada.
