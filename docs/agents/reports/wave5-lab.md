# Relatório — wave5-lab (Harness Lab, fase 3: proponentes INV/DOM, compositor e modo sequencial)

## O que foi feito

### Tipos (`src/shared/harness.ts`, só acréscimos opcionais, como a exceção da missão permite)
- `LabRound` ganhou `mode`, `depth`, `proposerModel`, `costCapUsd` e `stages`.
- `LabVariant` ganhou `role`, `roleLabel`, `stageId`, `step` e `inPool`.
- Tipos novos: `LabMode`, `LabVariantRole` e `LabStage` (id, dim INV/DOM/COMPOSE, passo, status, tentativas,
  `keptBase`, `fellBack`, erro, notas, árvore resultante, árvore de partida, custo, duração e variante que a executa).
- Constantes e funções novas: `LAB_PARALLEL_MAX` (2), `LAB_SEQUENTIAL_MAX` (3) e `labRoundPlan()`. O plano é
  paralelo k → 2+2k execuções e 2k+1 chamadas; sequencial K → 1+3K execuções e 3K chamadas. Para paralelo k=1 dá
  4 execuções + 3 chamadas.

### Main (`src/main/features/lab/`)
- `prompts.ts`: prompts adaptados (não copiados) de `propose()`, `_INV_TEMPLATE`, `_DOM_TEMPLATE`, `GENERALIZE`,
  `aggregate()`, `compose_round()`, `_KEEP_BASE`, `ANSWER_FREE`, `EVIDENCE_BOUNDARY` e `_SURFACE_*` do harness2.
  - A superfície descrita é a do Claude Code: CLAUDE.md sempre carregado; skills carregadas pela `description`;
    subagentes; comandos (que nunca rodam sozinhos); hooks em `.claude/settings.json`; `.claude/scripts`.
  - Inclui a ordem de preferência de componentes, as regras que descartam a proposta e "o formato do entregável é
    da tarefa".
  - INV e DOM são separados e um não invade o outro. Toda edição deve apontar um momento da trajetória, com a
    preferência divergência > falha repetida > risco visível.
  - GENERALIZE separa fatos do repositório de procedimento do projeto, e um componente nomeado vence prosa.
  - O compositor tem dois formatos: o paralelo (MERGE / adotar um inteiro / KEEP_BASE, notas
    `kept|revised|dropped -> … -> …`) e o checkpoint t/K do sequencial (pode reproduzir um checkpoint anterior, e
    KEEP_BASE mantém o checkpoint atual).
  - Marcado "Adapted from google-research/harness2 (Apache-2.0)".
- `propose.ts`: um estágio de proponente ou compositor.
  - Monta `<userData>/hangar-data/lab/ctx/<rodada>/<estágio>/` com `task.md`, `base_harness/**`, `harness/**` (a
    cópia editável), `runs/<rótulo>/{trajectory.md, final.md, changes.patch}`, `candidates/<rótulo>/{harness/**,
    notes.md}` (compositor e histórico do sequencial) e `library/` (lições ativas via `listLessons` e até 3
    snapshots `lab` como exemplos).
  - Roda uma query headless com cwd nesse diretório, `tools: [Read, Glob, Grep, Write, Edit]`, `disallowedTools`
    (Bash, WebFetch, WebSearch, Task, NotebookEdit, MultiEdit, TodoWrite), `permissionMode: 'default'`,
    `settingSources: []`, `persistSession: false` e `abortController`.
  - O `canUseTool` só deixa ler dentro do diretório e só deixa escrever em `harness/` num caminho que `isHarnessPath`
    aceita; o resto é negado com uma mensagem que explica o motivo. Como não há ferramenta de apagar, um arquivo
    esvaziado sai da árvore.
  - A nova árvore é o conteúdo final de `harness/`, validado. As notas vêm de `<notes>…</notes>` ou da linha
    KEEP_BASE.
  - Uma proposta **inválida ganha UMA nova tentativa**, com "YOUR PREVIOUS ATTEMPT WAS REJECTED" e o motivo. Se
    falhar de novo, **herda o harness atual** (`fellBack`). Uma falha da chamada em si também herda, como no
    harness2.
- `validate.ts`: rejeita
  - arquivos fora da superfície;
  - `SKILL.md` ausente ou sem frontmatter `name` = pasta + `description`;
  - subagente sem `name`/`description`;
  - `settings.json` inválido;
  - arquivo `.claude/…` citado e inexistente;
  - CLAUDE.md somado acima de 20 mil caracteres;
  - `harness/` esvaziado.
- `pipeline.ts`:
  - **paralelo k**: base → k INV + k DOM a partir da evidência da base → cada proposta roda 1× → compositor `agg` →
    composto roda 1× → seleção cega entre base, propostas e composto.
  - **sequencial K**: base → para cada t, INV + DOM sobre o checkpoint atual com todo o histórico → ambos rodam →
    compositor `c<t>` → checkpoint roda (vira evidência do passo seguinte) → seleção cega entre base e checkpoints.
    As execuções INV/DOM ficam fora do pool (`inPool: false`).
  - Cada execução recebe um nome neutro ("Execução N"), um id aleatório e uma sessão chamada
    "Lab · <tarefa> · Execução N". O papel ("Base", "INV 1", "Composto", "Checkpoint 1") só é revelado depois da
    escolha.
- `runs.ts` (saiu de `rounds.ts`): preparação e execução de variantes. Os worktrees são criados com um lock, e a
  execução pode ser aguardada (`waitForRound`). O entregável é coletado **assim que cada execução termina**, porque
  vira evidência do estágio seguinte. Também ficam aqui a finalização com o pool cego, `stopRound` (cancelar ou
  teto) e `enforceCap`.
- **Teto de custo**: a soma das execuções, das chamadas de proponente/compositor e da seleção é conferida a cada
  mudança da rodada. Se passar do teto, a rodada é cancelada, as chamadas em andamento são abortadas e as sessões
  interrompidas, com a mensagem "Teto de custo de US$ X ultrapassado (gasto: US$ Y)".
- `phases.ts`: linha do tempo agregada por fase (status, n/total, custo, tempo, nº de novas tentativas e de
  heranças) que **não liga** execuções a papéis. `store.toView()` esconde das rodadas automáticas, até a decisão,
  árvores, papéis, notas e o vínculo estágio→execução.
- Refletir passa todos os candidatos com `adopted` marcado, os nomes revelados e as notas do proponente.
- Limpar também apaga `lab/ctx/<rodada>`. A reconciliação ao abrir o app trata rodadas automáticas interrompidas:
  com a base pronta, abre a seleção com o que terminou; sem ela, a rodada falha.

### Renderer (`src/renderer/src/features/lab/`)
- **Nova rodada**:
  - seletor de modo (Manual | Automático · paralelo | Automático · sequencial) com uma explicação de cada um;
  - modelo das execuções, `k` ou `K`, modelo dos proponentes e teto de custo opcional;
  - **estimativa**: nº de execuções e de chamadas (e o máximo com novas tentativas), mais um valor em US$ quando há
    rodadas anteriores com custo.
- **Detalhe**: `PipelineTimeline` (Execução da base → Propostas INV/DOM → Execuções → Composição → Execução do
  composto/checkpoint → Seleção cega), o "gasto X de Y" no cabeçalho e as execuções com nomes neutros.
- **Depois da escolha**: os nomes revelados, a tabela com papel e nome neutro e a seção "Propostas e composição".
  Cada estágio mostra as badges KEEP_BASE, "herdou o harness atual" e "n tentativas", além de custo, tempo, em qual
  execução e candidato rodou, as notas e o diff contra a base (chips por arquivo que abrem um diff unificado).
  Adotar, Refletir e Limpar continuam.

## Como testar / o que verifiquei
- `npm run typecheck` e `npm run build` passam.
- O E2E rodou no app real com `--user-data-dir` isolado e a porta **9563**, via CDP, num repositório git temporário
  no scratch (`CLAUDE.md` simples + `calc.py`). Execuções e proponentes usaram haiku.
  1. **Paralelo k=1**: completou até a seleção cega com as 4 execuções no pool (US$ 0,052). INV, DOM e compositor
     responderam KEEP_BASE, com notas que citam a trajetória; é legítimo numa tarefa trivial. O projeto não foi
     tocado (`git status` vazio). A escolha cega pela UI e a revelação dos estágios funcionaram.
  2. **Sequencial K=1**, com `HANGAR_LAB_SIMULATE_INVALID=inv1` e `HANGAR_LAB_TEST_INSTRUCTION`: completou até a
     seleção cega (pool = base + Checkpoint 1).
     - `inv1` fez 2 tentativas, `fellBack`, e ficou com árvore = base.
     - `dom1` criou `.claude/skills/demo/SKILL.md` dentro de `harness/`.
     - A tentativa de escrever `outside.txt` fora de `harness/` foi **negada** ("Only files under harness/ can be
       changed."). Nenhum arquivo apareceu fora de `harness/`, e todas as árvores tinham só caminhos de harness.
     - "Pedir ao Claude" decidiu.
  3. **Teto de US$ 0,001**: a rodada parou depois da base (gasto US$ 0,0099), com a mensagem de teto.
  4. **Limpeza**: as 3 rodadas foram limpas pelo Lab (worktrees, branches `lab-*` e sessões arquivadas) e o repo
     ficou só com `main`. Apaguei as 17 pastas de sessões de teste (ondas 4 e 5) desta sessão em
     `~/.claude/projects`. Os proponentes e o seletor usam `persistSession: false` e não deixam sessões. Nenhum
     processo órfão.
- Os screenshots dos temas claro e escuro foram conferidos.

## O que ficou faltando / limitações
- Cada candidato roda **uma vez** e a base também: é evidência fraca, e os prompts dizem isso. Não há k execuções
  da base como no harness2 (o brief pede a base 1×).
- O teto só enxerga o custo de uma execução ou chamada quando ela termina, então a rodada pode passar um pouco do
  teto antes de parar.
- Os nomes neutros não escondem o tempo: quem acompanha ao vivo sabe que a "Execução 1" é a base. Os ids da seleção
  cega (A, B, C…) são reembaralhados à parte e não correspondem aos nomes neutros.
- Os ganchos de teste `HANGAR_LAB_SIMULATE_INVALID` e `HANGAR_LAB_TEST_INSTRUCTION` (variáveis de ambiente) ficam
  no código, documentados nos comentários.

## Pedidos ao chief
- Nenhuma mudança obrigatória.
- Opcional: incluir no `NOTICE` uma menção às novas adaptações dos prompts de proponente e compositor do harness2,
  em `src/main/features/lab/prompts.ts`.

## Riscos conhecidos
- Os proponentes leem as transcrições: o conteúdo é tratado como dado (EVIDENCE_BOUNDARY) e as ferramentas são
  restritas, mas um texto malicioso ainda pode influenciar a proposta. A validação, a seleção cega e a confirmação
  ao adotar são as barreiras.
- Um hook proposto em `.claude/settings.json` roda de verdade nas execuções da variante, dentro do worktree. O prompt
  pede hooks pequenos e permissivos, mas a validação não analisa o comando.
- Custo: paralelo k=2 dá 6 execuções e 5 chamadas, e sequencial K=3 dá 10 execuções e 9 chamadas. Use o teto.
