# Missão: sessions (sidebar, sessões e projetos)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `sessions`.
Suas pastas: `src/main/features/sessions/`, `src/renderer/src/features/sessions/`, `src/shared/features/sessions.ts`.

## Renderer

`Sidebar()` (coluna esquerda):
- Botão "Nova sessão" (Ctrl+N) → `useUi().selectSession(undefined)` mostra a `NewSessionView`.
- Campo de busca: filtra títulos na hora e, com Enter ou após 300 ms, busca nas transcrições via `engine:search`.
- Lista: seção "Fixadas", grupos do usuário (colapsáveis, renomear, excluir, reordenar), "Recentes" (por `updatedAt`),
  "Arquivadas" (colapsada). Opcional: agrupar por projeto.
- Item: título, pasta curta, tempo relativo, indicador de status (trabalhando = spinner, aguardando = ponto âmbar,
  não lida = ponto de destaque, erro = vermelho). Clique seleciona e zera `unread`.
- Menu de contexto do item: Renomear, Fixar/Desafixar, Mover para grupo (incluindo novo grupo), Arquivar/Desarquivar,
  Exportar como Markdown (usa `engine:history` e salva com diálogo), Abrir pasta, Excluir (com confirmação; se tiver
  worktree, pergunte se remove também).
- Arrastar e soltar sessões entre grupos.
- Rodapé: projetos (lista + "Novo projeto": nome, pasta, instruções) e "Importar sessões do Claude Code".
- Atalhos: Ctrl+N, Ctrl+B (alternar sidebar via `useUi().toggleSidebar`), Ctrl+Shift+↑/↓ sessão anterior/próxima.

`NewSessionView()` (centro quando nenhuma sessão está selecionada):
- Saudação ("Em que vamos trabalhar?"), seletor de pasta (pastas fixadas e recentes de `settings()`, botão "Escolher pasta"
  via `api.pickFolder`, fixar/desafixar pasta), seletor de projeto opcional.
- Opção "Worktree isolado" (só se `git:isRepo` for true): chama `git:worktreeCreate` e grava `session.worktree`.
- Seletores rápidos de modelo e modo de permissão (padrões de `settings()`).
- Textarea do primeiro prompt. Ao enviar: cria a `Session` (id com `nanoid`, título provisório "Nova sessão"),
  atualiza `recentFolders`, seleciona a sessão e chama `engine:send`.

`SessionHeader({ session })` (barra superior): renomear inline com duplo clique no título, fixar e um menu "…" com as
mesmas ações do menu de contexto.

## Main

- IPC para o que não cabe no store genérico: `sessions:create`, `sessions:delete` (remove worktree via
  `removeWorktree` de `git/api.ts` quando pedido), `sessions:exportMarkdown`, `sessions:importCli`, `sessions:listCli`.
- Importar do Claude Code CLI: varra `%USERPROFILE%\.claude\projects\*\*.jsonl`, extraia `sessionId`, `cwd`, primeira
  mensagem do usuário (título) e data; mostre uma lista com checkboxes; ao importar, crie `Session` com `sdkSessionId`
  para o engine retomar. Pule as já importadas.
- Projetos e grupos usam `db('projects')`/`db('groups')`.

## Pronto quando

Criar, selecionar, renomear, fixar, agrupar, arquivar, exportar, excluir e importar sessões funciona, e a lista atualiza
sozinha quando o engine muda o status de uma sessão.
