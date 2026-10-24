# Missão: git (Changes, Files e worktrees)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `git`.
Suas pastas: `src/main/features/git/`, `src/renderer/src/features/git/`, `src/shared/features/git.ts`.

Use o `git` CLI via `execFile` (sem shell, argumentos em array, `maxBuffer` grande, timeout). Sem bibliotecas novas.
`gh` não está instalado: recursos de PR só aparecem se `gh` existir no PATH.

## Main

- Exporte `src/main/features/git/api.ts` com exatamente as funções da RULES.md:
  `createWorktree(cwd, branch?)` cria em `<raiz do repo>/../.hangar-worktrees/<repo>-<slug>` um branch novo
  `hangar/<slug>` a partir do HEAD atual; `removeWorktree(wt)`; `isGitRepo(cwd)`.
- IPC: `git:isRepo`, `git:worktreeCreate`, `git:status` (branch, ahead/behind, arquivos staged/unstaged/untracked),
  `git:diff` (arquivo, staged?) → texto unificado, `git:stage`, `git:unstage`, `git:discard` (o renderer confirma antes),
  `git:commit` (mensagem), `git:branches`, `git:checkout`, `git:createBranch`, `git:push`, `git:log` (últimos N commits),
  `git:prStatus` (só com `gh`), `files:list` (diretório → entradas, ignorando `.git` e `node_modules` e respeitando
  `.gitignore` via `git check-ignore` quando for repo), `files:read` (texto até 1 MB, detecta binário), `files:openInEditor`.
- Atualização automática: observe a pasta da sessão (`fs.watch` recursivo com debounce) e o evento
  `session:turn-ended` do bus; emita `git:event:changed` ({ cwd }).

## Renderer

`ChangesPanel({ session })`:
- Cabeçalho com branch atual (trocar/criar branch), ahead/behind e botão Push.
- Lista de arquivos alterados agrupada (Staged, Alterações, Não rastreados) com ações por arquivo (stage, unstage,
  descartar com confirmação) e "stage tudo".
- Visualizador de diff do arquivo selecionado: unificado com números de linha, cores `--diff-add`/`--diff-del`,
  alternância para lado a lado.
- Caixa de mensagem de commit + botão Commit (Ctrl+Enter). Estado vazio amigável quando não é repositório.

`FilesPanel({ session })`:
- Árvore de arquivos lazy, filtro por nome, ícone por tipo; clique abre o visualizador com destaque de sintaxe (`shiki`,
  lazy) e números de linha; botões "Abrir no editor" e "Copiar caminho".

## Pronto quando

Numa pasta com repo git, o painel mostra mudanças feitas pelo agente em tempo real, o diff aparece certo, dá para
stage/commit, e `createWorktree` cria e remove worktrees de verdade (teste num repo temporário no scratch do sistema,
nunca no repo do Hangar).
