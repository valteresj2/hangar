# Relatório — feature `git` (Changes, Files e worktrees)

## O que foi feito

### Main (`src/main/features/git/`)
- `exec.ts` — wrapper do `git` CLI via `execFile` (sem shell, args em array, `maxBuffer` 64 MB, timeout padrão 30 s,
  `stdin` opcional). Ambiente fixo: `GIT_TERMINAL_PROMPT=0` (nunca trava pedindo credencial), `GIT_OPTIONAL_LOCKS=0`
  (leituras não tocam no `.git/index`, evitando loop com o watcher), `core.quotepath=off`. `gitPaths()` usa
  `--literal-pathspecs` nos comandos que recebem caminhos (add/reset/rm/restore/diff).
- `api.ts` — contrato da RULES.md:
  - `createWorktree(cwd, branch?)` → cria `<raiz do repo principal>/../.hangar-worktrees/<repo>-<slug>`, a partir do
    HEAD atual. Sem `branch`: branch novo `hangar/<aaaammdd-xxxx>`. Com `branch` válido (`git check-ref-format`): usa o
    nome exatamente como veio (se já existir, faz checkout dele no worktree). Com nome inválido (ex.: título de sessão
    "Minha Tarefa!"): vira `hangar/minha-tarefa`. Nomes gerados ganham sufixo `-2`, `-3`… se colidirem. Funciona
    também quando `cwd` já é um worktree (usa o repo principal via `--git-common-dir`).
  - `removeWorktree(wt)` → `git worktree remove --force`, apaga a pasta se sobrar, `worktree prune` e apaga o branch
    **só** se começar com `hangar/` e estiver mergeado (`branch -d`). Trabalho não mergeado nunca se perde.
  - `isGitRepo(cwd)` → `false` para pasta inexistente ou fora de repo.
- `ops.ts` — status (`--porcelain=v2 -z`, branch/upstream/ahead/behind, staged/unstaged/untracked, renomeações,
  conflitos, limite de 2000 por grupo), diff (working tree, `--cached`, e `--no-index` para não rastreados; limite de
  2 MB, detecção de binário), stage/unstage (funciona também antes do primeiro commit), discard (`git restore`; não
  rastreados são apagados do disco, com proteção contra caminhos fora do repo), commit (mensagem via stdin, `-F -`),
  branches (locais + remotos), checkout (`git switch`; branch remoto cria o tracking local), createBranch, push
  (`push -u <origin|primeiro remote> <branch>` quando não há upstream), log, prStatus (só se `gh` existir no PATH;
  detecção cacheada).
- `files.ts` — `files:list` (filhos diretos, pastas primeiro, sem `.git`/`node_modules`, marca `ignored` via
  `git check-ignore --stdin -z`), `files:find` (busca por nome: `git ls-files -co --exclude-standard` em repos, varredura
  limitada fora deles), `files:read` (até 1 MB, detecta binário por byte NUL), `files:openInEditor` (VS Code ou Cursor
  achados no PATH, lançados destacados com `--goto arquivo:linha`; senão `shell.openPath`).
- `watch.ts` — `fs.watch` recursivo com contagem de referências por pasta e debounce de 350 ms. Ignora
  `node_modules`, `*.lock` e o interior de `.git`, exceto `index`, `HEAD` e `refs/`, que são o que muda num
  stage/commit/checkout feito fora do app.
- `index.ts` — registra todos os canais. Emite `git:event:changed { cwd }` quando: o watcher dispara; uma operação que
  altera o repo termina (stage/commit/checkout/…); ou chegam do bus os eventos `session:turn-ended` e
  `session:file-written` (pasta = `worktree?.path ?? cwd` da sessão). Os watches de cada janela são liberados quando o
  `webContents` é destruído. `dispose()` fecha tudo.

### Canais (`src/shared/features/git.ts`)
`GIT`: `isRepo`, `worktreeCreate`, `worktreeRemove` (extra), `status`, `diff`, `stage`, `unstage`, `discard`, `commit`,
`branches`, `checkout`, `createBranch`, `push`, `log`, `prStatus`, `watch`/`unwatch` (extra: o renderer pede para
observar uma pasta enquanto o painel está aberto), evento `git:event:changed`.
`FILES`: `list`, `find` (extra), `read`, `openInEditor`. Também tem os tipos de payload e o helper `samePath()`.

### Renderer (`src/renderer/src/features/git/`)
- `index.tsx` mantém os exports `ChangesPanel({ session })` e `FilesPanel({ session })`.
- **ChangesPanel**: menu de branch (filtra, troca, cria; remotos criam o tracking local), ↑ahead ↓behind, chip de PR
  (com `gh`), histórico de commits, atualizar, Push/Publicar. Caixa de commit com Ctrl+Enter. Se nada estiver staged,
  pergunta se deve fazer stage de tudo. Grupos recolhíveis (Staged, Alterações, Não rastreados) com stage, unstage e
  descartar por arquivo, e com "Stage tudo", "Unstage tudo" e "Descartar/Excluir tudo", sempre com `confirm` antes de
  descartar. Duplo clique abre no editor. O diff tem números de linha, cores `--diff-add`/`--diff-del` e alterna entre
  Unificado e Lado a lado (a escolha fica em `localStorage`). Fora de um repo mostra um estado vazio amigável, com
  árvore limpa mostra "✓ Nenhuma alteração", e erros do git aparecem numa barra que dá para fechar.
- **FilesPanel**: árvore lazy (carrega a pasta ao expandir), filtro por nome (busca no main com debounce), ícone por
  tipo, alternância para mostrar arquivos ignorados, recolher tudo. O visualizador usa `shiki` com carregamento lazy,
  motor **JavaScript** (a CSP do renderer bloqueia wasm), temas github claro/escuro via `--shiki-dark` e números de
  linha. Arquivos acima de 300 KB aparecem como texto simples, e binários ou truncados são avisados. Tem os botões
  "Abrir no editor" e "Copiar caminho". A árvore e o arquivo aberto recarregam sozinhos quando o disco muda.

## Como testar
1. Abra uma sessão numa pasta com repo git, clique em **Changes** na TopBar e peça ao agente para editar arquivos. A
   lista atualiza em cerca de 0,4 s (medido) e o diff do arquivo selecionado acompanha.
2. Faça stage e unstage de arquivos, descarte (aparece a confirmação), escreva uma mensagem e use Ctrl+Enter. O commit
   aparece no histórico (☰).
3. No menu de branch, digite um nome novo e use "Criar branch". Depois troque de volta.
4. Em **Files**: expanda pastas, filtre por nome, abra um `.ts` (com destaque de sintaxe) e use "Abrir no editor".
5. Worktrees: `createWorktree(cwd)` e `removeWorktree(wt)` de `src/main/features/git/api.ts`, ou pelo renderer:
   `window.hangar.invoke('git:worktreeCreate', cwd)`.

O que verifiquei:
- `npm run typecheck` e `npm run build` passam na árvore real (agora há pouco, já com o trabalho dos outros agentes).
- Teste de integração do main num repo temporário no scratch, nunca no repo do Hangar: status com renomeação e nome
  acentuado, diffs (unstaged, staged com rename, untracked), stage/unstage sem HEAD, discard e a proteção de caminho,
  commit, branches, checkout, push sem remote (dá erro amigável) e prStatus sem `gh`. Também `createWorktree` sem
  branch, com nome inválido, com branch existente e a partir de dentro de um worktree. `removeWorktree` limpou as pastas
  e os branches `hangar/*` mergeados e manteve o que tinha commit não mergeado.
- App real (Electron), com um harness que monta os dois painéis numa cópia isolada (HEAD + meus arquivos), dirigido via
  CDP com screenshots: diff unificado e lado a lado, atualização ao vivo, árvore + shiki, tema escuro, "Stage tudo" +
  commit por Ctrl+Enter (o commit entrou no `git log`), filtro de arquivos, menu de branch e histórico. Os processos
  foram encerrados no fim.

## O que ficou faltando / limitações
- Sem stage parcial (por hunk ou linha), sem pull/fetch e sem resolver conflitos. Conflitos aparecem com `!` em
  Alterações.
- O diff não tem destaque de sintaxe, só as cores de adição e remoção.
- O PR só mostra o status (`gh pr view`). Não há botão de criar PR, porque `gh` não está instalado aqui e não pude testar.
- Os ícones de arquivo são glifos de texto (sem pacote de ícones).
- Não implementei "Push" com força nem escolha de remote.

## Pedidos ao chief
- **Nenhuma mudança obrigatória.** Sugestões opcionais:
  - `src/renderer/src/shell/TopBar.tsx`: os rótulos "Changes" e "Files" estão em inglês. Sugestão: "Alterações" e
    "Arquivos".
  - `src/main/core/bus.ts`: no comentário do topo, anotar que o git escuta `session:turn-ended` e
    `session:file-written` (não emite nada no bus).
- Para o agente **sessions**, que usa os worktrees: chamar `removeWorktree(session.worktree)` ao excluir ou arquivar uma
  sessão em worktree, se quiser limpar. Se o `branch` passado for o título da sessão, ele vira `hangar/<slug>`
  automaticamente.

## Riscos conhecidos
- `fs.watch` recursivo em pastas muito grandes ou no OneDrive pode gerar muitos eventos. O debounce de 350 ms e os
  filtros seguram isso, mas cada rajada ainda dispara um `git status`.
- "Abrir no editor" procura `code`/`cursor` no PATH e lança `Code.exe`/`Cursor.exe` ao lado do shim (layout padrão do
  instalador). Em instalações fora do padrão, cai para o app padrão do sistema.
- `discard` em não rastreados apaga do disco (`rm -r`), sempre depois de `confirm` no renderer. Pelo IPC direto, não há
  confirmação.
- `LC_ALL=C` deixa as mensagens de erro do git em inglês. Elas são mostradas como vieram.
