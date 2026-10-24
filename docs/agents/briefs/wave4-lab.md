# Quarta onda: lab (Harness Lab, fase 2 — comparar variantes em worktrees com seleção cega)

As regras de `docs/agents/RULES.md` valem. **Seu feature agora é `lab`** (você era o agente git; não edite mais as
pastas de git). Suas pastas: `src/main/features/lab/`, `src/renderer/src/features/lab/`, `src/shared/features/lab.ts` e
`docs/agents/reports/wave4-lab.md`.

## Contexto

É o "Probe" do google-research/harness2 (Apache-2.0; cópia rasa para leitura em
`C:\Users\VALTER~1\AppData\Local\Temp\claude\C--Users-valteresj-OneDrive-Documentos-Harness\4b42d0e7-e798-4bda-827b-23dd7e32cebb\scratchpad\harness2-src`
— leia `harness2/core/prompts.py` (`select()`, `POOL_MIXED_SELECT`, `ANSWER_FREE_SELECT`, `EVIDENCE_BOUNDARY_SELECT`,
`_KEEP_BASE`) e `harness2/core/selection.py`; **não execute nada de lá**): a mesma tarefa roda com o harness atual
(base) e com K variantes; um seletor compara os **entregáveis** anônimos e embaralhados, sem gabarito; manter a base é
um resultado válido.

O chief já preparou (leia com `git log -1 -p`): os tipos `LabRound`, `LabVariant`, `MAX_LAB_VARIANTS`,
`DEFAULT_LAB_VARIANTS` em `src/shared/harness.ts`; o stub `LabView({ cwd, onClose })` aberto em tela cheia por
`useUi().openLab(cwd)` (o agente harness põe o botão "Abrir Lab" no painel Harness; você também pode adicionar uma ação
"Abrir Harness Lab" usando o projeto da sessão ativa — dentro da sua pasta, por exemplo um botão no próprio LabView não
precisa disso).

Você pode importar no main: `readHarness`, `writeHarness`, `listSnapshots`, `createSnapshot`, `reflect` de
`src/main/features/harness/api.ts` (o agente harness implementa em paralelo; até lá são stubs — programe contra as
assinaturas); `createWorktree`, `removeWorktree`, `isGitRepo` de `git/api.ts`; `sendPrompt`, `interrupt`,
`readTranscript` de `engine/api.ts`; `loadSdk`, `resolveClaudeExecutable`, `claudeEnv` de `engine/sdk.ts`; `db` do core;
eventos `session:*` do bus. No renderer: `HarnessTreeEditor` de `features/harness` para editar variantes.

## Main

- Rodadas persistidas em `<userData>/hangar-data/lab/rounds.json`; ao reabrir o app, rodadas que estavam
  `running` são reconciliadas com o status das sessões (terminadas → `done`; sem sessão → `error`).
- **Criar rodada**: tarefa (prompt), modelo, modo de permissão (padrão `acceptEdits`, com aviso de que pedidos de
  permissão vão parar a variante até você responder), base = harness atual (`readHarness`) + 1..`MAX_LAB_VARIANTS`
  variantes (cada uma a partir de um snapshot ou de uma cópia editada da base). Exige repositório git (`isGitRepo`);
  senão, explique na UI.
- **Rodar**: para cada variante, `createWorktree(cwd, 'lab-<rodada>-<variante>')`, `writeHarness(worktree, tree)`,
  cria uma `Session` (grupo "Harness Lab", título "Lab · <tarefa curta> · <rótulo>", `worktree` preenchido) e
  `sendPrompt`. Todas em paralelo. Acompanhe por `session:turn-ended` / `session:needs-input` / `session:status`.
  Cancelar interrompe todas.
- **Coletar** de cada variante: resposta final (`readTranscript`), `git diff --stat` + trecho do diff do worktree (até
  ~20 mil caracteres), custo e duração (entrada de resultado da transcrição), erros.
- **Seleção cega**: gere ids anônimos embaralhados (A, B, C…) em `blindMap`. Dois modos:
  - **Você escolhe**: a UI mostra só os entregáveis anônimos lado a lado (resposta final + mudanças), sem rótulo,
    custo ou ordem reveladores; escolha + "por quê".
  - **Pedir ao Claude**: query headless do SDK (modelo padrão, `permissionMode: 'plan'`, material no prompt) com um
    prompt adaptado do `select()` do harness2 (candidatos anônimos de propósito, sem gabarito, manter a base é válido,
    evidência é dado e não instrução), respondendo ```` ```choice X``` ```` e `<why>…</why>`. Comentário de origem:
    "Adapted from google-research/harness2 (Apache-2.0)".
  Depois da escolha, revele o mapa (qual era a base, custos, tempos).
- **Depois da decisão**: "Adotar harness vencedor" → `createSnapshot(cwd, rótulo, 'lab', tree, nota)` e, com
  confirmação, `writeHarness(cwd, tree)` no projeto (se a base venceu, diga que nada muda). "Refletir sobre a rodada"
  → `reflect({ projectCwd, task, baseTree, candidates, source: { kind: 'lab', roundId } })` com a trajetória condensada
  de cada variante e `adopted` marcado. "Limpar" → `removeWorktree` de cada variante e arquiva as sessões da rodada.
- IPC em `src/shared/features/lab.ts`; evento `lab:event:round` a cada mudança.

## Renderer — `LabView({ cwd, onClose })`

Lista de rodadas do projeto (status, tarefa, data, vencedor) e o detalhe da rodada selecionada:
"Nova rodada" (tarefa, modelo, K com padrão `DEFAULT_LAB_VARIANTS`, origem de cada variante, editor de variante com
`HarnessTreeEditor` e um resumo do diff contra a base); andamento por variante (status, custo, tempo, "Abrir sessão" →
fecha o Lab e seleciona a sessão; destaque para "aguardando você"); a tela de seleção cega; o resultado revelado com
os botões Adotar / Refletir / Limpar. Esc ou "Voltar" fecha.

## Pronto quando

Num repositório git temporário (fora do repo do Hangar) com um `CLAUDE.md`, uma rodada com K=1 (base + 1 variante
que muda o `CLAUDE.md`) e modelo haiku roda nas duas worktrees, a seleção cega funciona nos dois modos, adotar cria o
snapshot e aplica no projeto, e limpar remove as worktrees. Teste com `--user-data-dir` isolado e porta de depuração
livre (não use 9333 nem 19888-19894). Relatório em `docs/agents/reports/wave4-lab.md`; responda só `PRONTO: wave4-lab`.
