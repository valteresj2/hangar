# Hangar — levantamento de funcionalidades

Referência: Claude desktop para Windows 3.6556.2 (`C:\Program Files\WindowsApps\Claude_3.6556.2.0_x64__...`).
Fonte: inventário das strings de UI (`resources/en-US.json`, ~870 strings do shell desktop; `ion-dist/i18n/en-US.json`, ~37 mil strings do frontend) e uso direto do app. Nenhum código do app foi copiado; ele serve só de referência funcional.

Prioridade: **P0** = MVP, **P1** = segunda onda, **P2** = depois / fora de escopo.

## 1. Conversa (chat e sessões de código)

| Função                                                                                       | Prioridade | Dono (workstream) |
| -------------------------------------------------------------------------------------------- | ---------- | ----------------- |
| Chat com streaming, markdown, blocos de código com copiar                                    | P0         | engine            |
| Exibição de chamadas de ferramenta (Read/Edit/Bash…) colapsáveis, com diff inline em edições | P0         | engine            |
| Pedido de permissão por ferramenta (permitir uma vez / sempre / negar)                       | P0         | engine            |
| Modos de permissão: Ask, Accept edits, Plan, Auto, Bypass                                    | P0         | engine            |
| Seletor de modelo, esforço (low…max), fast mode, thinking                                    | P0         | engine            |
| Interromper geração, retomar sessão, continuar após reiniciar o app                          | P0         | engine            |
| Anexar arquivos e imagens, colar imagem, @menção de arquivo                                  | P1         | engine            |
| Slash commands e skills no composer (`/`), autocomplete                                      | P1         | engine            |
| Lista de tarefas (todo) e plano fixos sob a última mensagem                                  | P1         | engine            |
| Uso de contexto / compactação, custo e tokens da sessão                                      | P1         | engine            |
| Rewind / fork de conversa a partir de uma mensagem                                           | P2         | engine            |
| Ditado por voz                                                                               | P2         | —                 |

## 2. Sessões, projetos e sidebar

| Função                                                                       | Prioridade | Dono           |
| ---------------------------------------------------------------------------- | ---------- | -------------- |
| Nova sessão de código numa pasta (seletor de pasta, pastas recentes/fixadas) | P0         | sessions       |
| Lista de sessões com status (trabalhando, aguardando você, ociosa, não lida) | P0         | sessions       |
| Renomear, fixar, arquivar, excluir sessão                                    | P0         | sessions       |
| Busca em sessões e transcrições                                              | P1         | sessions       |
| Grupos/seções na sidebar, arrastar sessões                                   | P1         | sessions       |
| Projetos (pasta + instruções + sessões agrupadas)                            | P1         | sessions       |
| Importar sessões do Claude Code CLI (`~/.claude/projects/*.jsonl`)           | P1         | sessions       |
| Sessão em worktree git isolado                                               | P1         | sessions + git |
| Split view (duas sessões lado a lado), reabrir sessão fechada                | P2         | shell          |
| Exportar transcrição (Markdown)                                              | P1         | sessions       |

## 3. Painel lateral (side panel)

| Função                                                                   | Prioridade | Dono     |
| ------------------------------------------------------------------------ | ---------- | -------- |
| Terminal integrado com várias abas (PowerShell/bash), na pasta da sessão | P0         | terminal |
| Changes: diff dos arquivos alterados (working tree vs HEAD), por arquivo | P0         | git      |
| Files: árvore de arquivos e visualizador com destaque de sintaxe         | P1         | git      |
| Commit, branch, push; status de PR (quando houver `gh`)                  | P1         | git      |
| Browser embutido com abas (URL, voltar, recarregar)                      | P1         | preview  |
| Preview de dev server (`.claude/launch.json`)                            | P1         | preview  |
| Artifacts: renderizar HTML/SVG/Markdown gerado pelo agente, sandboxado   | P1         | preview  |
| Side chat (conversa paralela curta sem poluir a sessão)                  | P2         | engine   |

## 4. Extensões e integrações

| Função                                                                         | Prioridade | Dono           |
| ------------------------------------------------------------------------------ | ---------- | -------------- |
| Gerenciar servidores MCP (listar, adicionar, remover, ligar/desligar, ver log) | P0         | settings       |
| Listar skills e plugins instalados (`~/.claude/skills`, plugins)               | P1         | settings       |
| Tarefas agendadas (rodar um prompt numa pasta em cron)                         | P1         | settings       |
| Hooks (visualizar `settings.json`)                                             | P2         | settings       |
| Claude in Chrome, computer use, Cowork VM, dispositivos/hardware               | P2         | fora de escopo |

## 5. App desktop

| Função                                                                       | Prioridade | Dono     |
| ---------------------------------------------------------------------------- | ---------- | -------- |
| Janela com sidebar recolhível, painel lateral redimensionável                | P0         | shell    |
| Configurações: tema claro/escuro/sistema, modelo/modo padrão, pasta de dados | P0         | settings |
| Command palette (Ctrl+K) e atalhos de teclado                                | P1         | settings |
| Notificações do sistema quando uma sessão termina ou pede permissão          | P1         | settings |
| Ícone na bandeja e Quick Entry por atalho global                             | P2         | settings |
| Auto-update, relatório de diagnóstico, logs                                  | P2         | —        |
| Login: usa o login existente do Claude Code CLI (assinatura) — sem API key   | P0         | engine   |

## Fora de escopo (por depender de serviços da Anthropic)

Contas/organização/billing, compartilhamento de artifacts em claude.ai, Remote Control/Dispatch entre dispositivos, sessões na nuvem, conectores OAuth hospedados, Cowork VM.
