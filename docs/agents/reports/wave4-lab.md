# Relatório — wave4-lab (Harness Lab, fase 2: variantes em worktrees com seleção cega)

## O que foi feito

### Main (`src/main/features/lab/`)
- `store.ts` — as rodadas ficam em `<userData>/hangar-data/lab/rounds.json` (gravação com debounce e atômica). Cada
  mudança emite `lab:event:round`. `toView()` decide o que o renderer pode ver: o `blindMap` e os entregáveis por
  variante só são entregues depois da decisão.
- `rounds.ts` — ciclo de vida `preparing → running → selecting → decided` (ou `failed`/`cancelled`):
  - **Criar**: valida a tarefa, K entre 1 e `MAX_LAB_VARIANTS`, `isGitRepo` e a existência de commits. A base é o
    resultado de `readHarness(projeto)`. Cada variante vem de uma cópia editada da base ou de um snapshot.
  - **Rodar**: os worktrees são criados um por vez, porque o git usa locks do repositório inteiro, com
    `createWorktree(cwd, 'lab-<rodada>-<token>')`. O token é aleatório, para que o caminho não revele qual worktree é
    a base. Depois vêm `writeHarness(worktree, tree)` e a gravação de um *tree object* de referência (com um índice
    temporário, sem tocar no índice do worktree). Cada variante ganha uma `Session` no grupo "Harness Lab", com
    título "Lab · <tarefa curta> · <rótulo>" e o `worktree` preenchido. Por fim, `sendPrompt` vai para todas em
    paralelo.
  - **Acompanhamento**: `session:turn-ended` marca a variante como concluída ou com erro, lendo custo e duração da
    entrada de resultado da transcrição. `store:changed` detecta uma sessão excluída no meio da rodada. Quando todas
    as variantes terminam, a coleta reúne a resposta final, o `git diff --stat` e um trecho do diff (até 20 mil
    caracteres) entre o tree de referência e o estado final. Ela também pega os erros e troca os caminhos e o branch
    do worktree por `<repo>`. Em seguida o `blindMap` é embaralhado com `crypto.randomInt` (ids A, B, C…). Se nenhuma
    variante entregou, a rodada vira `failed`.
  - **Cancelar**: marca as variantes pendentes como canceladas e chama `interrupt` em todas.
  - **Reconciliar ao abrir o app**: `preparing` vira `failed`. Em `running`, variantes sem sessão viram erro;
    variantes com resultado na transcrição viram concluída ou erro; variantes sem resultado viram erro (o app fechou
    no meio). Depois a seleção é aberta. Uma escolha do Claude que estava em andamento é marcada como interrompida.
  - **Adotar**: `createSnapshot(projeto, rótulo, 'lab', tree, nota)`. Com `apply`, também chama
    `writeHarness(projeto, tree)`. Se a base venceu, devolve `unchanged` e nada muda.
  - **Refletir**: chama `reflect({ projectCwd, task, baseTree, candidates, source: { kind: 'lab', roundId } })` com a
    trajetória condensada de cada variante (pedidos, ferramentas, erros, resposta final; até cerca de 12 mil
    caracteres), as mudanças, custo e tempo, e `adopted` marcado. O resultado fica guardado na rodada.
  - **Limpar**: cancela a rodada se estiver ativa, arquiva as sessões e libera os processos delas (veja "Pedidos ao
    chief"). Depois chama `removeWorktree` com até 8 tentativas, porque o Windows trava a pasta enquanto o processo
    sai, e apaga o branch `lab-…` com `git branch -d`, só se ele não tiver trabalho não mergeado.
- `select.ts` — o seletor é um prompt adaptado do `select()` do harness2: `POOL_MIXED_SELECT` (candidatos anônimos de
  propósito, escolher a base é válido), critérios na ordem entrega → correção contra o diff → consistência → aptidão
  → acabamento, `ANSWER_FREE_SELECT`, `EVIDENCE_BOUNDARY_SELECT` e a saída `<why>` + ```` ```choice X``` ````. Roda
  como uma query headless do SDK com o modelo padrão, `permissionMode: 'plan'`, `tools: []` e `settingSources: []`,
  num diretório vazio, então não lê o CLAUDE.md de nenhum projeto. O parse rejeita um id fora do pool. O comentário
  de origem diz "Adapted from google-research/harness2 (Apache-2.0)".
- `git.ts` — `snapshotTree` (via `GIT_INDEX_FILE` temporário), `diffTrees`, `hasHead` e `hasNonHarnessChanges`.
- `transcript.ts` — resultado da execução, resposta final e trajetória condensada.

### IPC (`src/shared/features/lab.ts`)
- Canais: `lab:list`, `lab:prepare`, `lab:create`, `lab:cancel`, `lab:candidates` (só os entregáveis anônimos, em
  ordem de id), `lab:choose`, `lab:askClaude`, `lab:adopt`, `lab:reflect`, `lab:cleanup` e `lab:remove`.
- Eventos: `lab:event:round` e `lab:event:removed`.
- Tipos: `LabRoundView` estende o `LabRound` do chief sem alterá-lo. Há também `BlindCandidate`, `LabDeliverable`,
  `AdoptResult` e `anonId()`.

### Renderer (`src/renderer/src/features/lab/`) — `LabView({ cwd, onClose })`
- Uma barra com "← Voltar" (Esc também fecha; o primeiro Esc dentro de um campo só tira o foco), o projeto e
  "Nova rodada". À esquerda fica a lista de rodadas, com status, tarefa, data e vencedor.
- **Nova rodada**:
  - campos de tarefa, modelo, permissões (padrão "Aceitar edições", com o aviso de que pedidos de permissão param a
    variante) e K (padrão `DEFAULT_LAB_VARIANTS`);
  - para cada variante: rótulo, origem (cópia da base ou snapshot), editor com o `HarnessTreeEditor` do harness e uma
    aba "Edição rápida" de reserva, mais um resumo do diff contra a base (arquivo, +/−) e aviso quando a variante é
    igual à base;
  - avisos para quando não há repo, não há commits ou há alterações não commitadas fora do harness.
- **Andamento**: status por variante ("Aguardando você" em destaque, a partir de `session.status === 'waiting'`),
  tempo correndo, custo, "Abrir sessão" (fecha o Lab e seleciona a sessão) e "Cancelar rodada".
- **Seleção cega**: os candidatos ficam lado a lado, sem rótulo, custo ou tempo, com a resposta final em markdown, o
  `--stat` e o diff recolhível. No modo "Você escolhe" há um rádio, o campo "por quê" e o botão confirmar. No modo
  "Pedir ao Claude" há um botão com estado "comparando…" e a mensagem de erro, se houver.
- **Resultado revelado**: o vencedor (candidato → variante, quem escolheu, por quê) e uma tabela com o mapa
  candidato/variante, a base marcada, status, custo e tempo. Os botões são:
  - **Adotar harness vencedor**: pergunta se deve criar o snapshot e aplicar, ou só criar o snapshot; fica
    desabilitado se a base venceu;
  - **Refletir sobre a rodada**: mostra a tabela de edições e a lição ou NO_ENTRY;
  - **Limpar worktrees e sessões**: pede confirmação.

  Também aparecem os entregáveis revelados e os botões "Sessão: <variante>". Depois da limpeza, há "Excluir rodada".

## Como testar / o que verifiquei
- `npm run typecheck` e `npm run build` passam na árvore atual, já com o trabalho do agente harness.
- O E2E foi feito com o app real (o `out/` buildado), com `--user-data-dir` isolado e a porta de depuração **9561**,
  dirigido via CDP com screenshots. O repositório git de teste ficou no scratch, com `CLAUDE.md`, e o modelo foi
  **haiku**:
  1. **Rodada 1**, K=1. A variante adicionou ao CLAUDE.md "encerre com 'Feito pelo Lab.'", escrita pela UI na
     "Edição rápida". As duas worktrees rodaram em cerca de 10 s (US$ 0,004 cada). Na seleção cega por "Você
     escolhe", a tela mostrava só A e B, e o mapa revelado foi A=base, B=variante. "Criar snapshot e aplicar" criou
     o snapshot `lab` com a nota e mudou o CLAUDE.md do projeto. "Refletir" gerou uma linha `CLAUDE.md … confounded`
     e NO_ENTRY.
  2. **Rodada 2**, K=1 (a variante pede docstrings). Em "Pedir ao Claude", ele escolheu B (a variante) com
     justificativa, por US$ 0,022.
  3. **Limpar**: na primeira tentativa a limpeza falhou com `EBUSY`, porque o processo do Claude Code da sessão
     seguia vivo com o cwd no worktree. Corrigi (veja abaixo) e repeti. As duas rodadas foram limpas e
     `git worktree list` mostrou só o `main`. Os branches `lab-*` e as pastas sumiram e as sessões ficaram
     arquivadas.
  4. Tema escuro conferido. Nenhum erro no console. Nenhum processo órfão ao final.

## O que ficou faltando / limitações
- Os worktrees partem do HEAD: alterações não commitadas fora do harness não chegam às variantes. A UI avisa.
- Uma rodada roda um único prompt. Se o usuário mandar mensagens extras na sessão de uma variante, elas entram na
  resposta final e no diff coletados.
- A anonimização tira caminhos e branch, mas a própria resposta pode citar o harness (ex.: "conforme o CLAUDE.md").
  Isso é comportamento real da variante, e o harness2 aceita o mesmo.
- Não implementei um atalho "Abrir Harness Lab" fora do painel Harness; o Lab abre pelo botão do agente harness.

## Pedidos ao chief
1. **API para encerrar uma sessão sem excluí-la**: por exemplo `closeSession(sessionId)` em
   `src/main/features/engine/api.ts`, chamando `closeRunner`. O ideal é que o engine, o terminal e o preview também
   liberem os recursos quando uma sessão é **arquivada**. Hoje só a exclusão da linha solta o processo do Claude Code,
   os terminais e os dev servers, e no Windows esses processos travam a pasta do worktree. **Contorno atual** em
   `rounds.ts` (`archiveAndRelease`): remover e repor imediatamente a linha da sessão, já arquivada. A transcrição é
   mantida. Efeitos colaterais: a sessão some e reaparece na sidebar por um instante, o ponto de rewind é descartado
   e o preview esquece os artifacts dessa sessão. Com a API, troco por uma chamada direta.
2. Opcional: adicionar a `src/main/core/bus.ts` que o lab escuta `session:turn-ended` e `store:changed` (sessões).
3. O mesmo `EBUSY` deve afetar `sessions:delete` com `removeWorktree` (ele interrompe e remove o worktree **antes** de
   apagar a linha). Vale inverter a ordem lá ou usar a API do item 1.

## Riscos conhecidos
- Em "Ignorar permissões", as variantes executam qualquer comando sem perguntar. A UI avisa.
- O seletor "Pedir ao Claude" usa o modelo padrão das configurações (opus por padrão), o que pode ser caro com
  diffs grandes. O material é limitado a 20 mil caracteres de diff e 12 mil de resposta por candidato.
- O retry da limpeza espera até cerca de 8 s por worktree. Se um processo externo (editor, terminal do sistema)
  segurar a pasta, a limpeza falha, informa o motivo e pode ser repetida.
