# Hangar

App desktop (Electron + React + TypeScript) para rodar e comandar sessões do Claude Code, inspirado no Claude desktop.
Usa o **Claude Agent SDK** com o login da sua assinatura que o `claude` CLI já tem — sem API key.

## Funcionalidades

- **Chat** com streaming, pensamento, cartões de ferramenta com diff, pedidos de permissão, interrupção, retomada de sessão,
  seletores de modelo / esforço / modo de permissão / fast mode, slash commands, anexos e custo/tokens/contexto por rodada.
- **Sessões**: sidebar com fixadas, grupos (arrastar e soltar), arquivadas, busca em títulos e transcrições, projetos com
  instruções, worktree git isolado por sessão, exportar Markdown, importar sessões do Claude Code CLI.
- **Painel lateral**: Terminal (node-pty + xterm, várias abas e shells), Alterações (status, diff, stage, commit, branch,
  push), Arquivos (árvore + visualizador com destaque), Navegador (abas com webview, dev servers do `.claude/launch.json`)
  e Artifacts (HTML/SVG/Markdown escritos pelo agente, renderizados isolados).
- **Configurações**: tema, padrões, caminho e login do `claude`, servidores MCP (via `claude mcp`), skills e plugins,
  tarefas agendadas (cron), atalhos; paleta de comandos (Ctrl+K), notificações e ícone na bandeja.

Detalhes e prioridades em [docs/FEATURES.md](docs/FEATURES.md).

## Rodando

```bash
npm install
npm run dev
```

Requisitos: Node 24+, Windows 11 (testado), `claude` CLI instalado e logado (`claude` → login com a assinatura).

Outros scripts: `npm run typecheck`, `npm run build`, `npm start` (roda o build).

## Arquitetura

- `src/main/core` — store JSON (`<userData>/hangar-data`), broadcast de mudanças, bus de eventos entre features, IPC base.
- `src/main/features/<feature>` e `src/renderer/src/features/<feature>` — um módulo por feature
  (`engine`, `sessions`, `terminal`, `git`, `preview`, `settings`); contratos de IPC em `src/shared/features/<feature>.ts`.
- `src/renderer/src/shell` — layout (barra superior, painel lateral).

O app foi construído em paralelo por seis agentes Claude Code coordenados via [herdr](https://herdr.dev);
briefings em `docs/agents/briefs/` e relatórios em `docs/agents/reports/`.
