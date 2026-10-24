# Quinta onda: lab (Harness Lab, fase 3 — proponentes INV/DOM, compositor e modo sequencial)

As regras de `docs/agents/RULES.md` valem. Você continua dono do feature `lab` (as mesmas pastas da onda 4).
**Exceção desta missão**: você pode ACRESCENTAR campos opcionais aos tipos do Lab em `src/shared/harness.ts`
(`LabRound`, `LabVariant`) e novos tipos ali; não renomeie nem remova nada.

## Contexto

Fase 3 do harness2 (cópia para leitura em
`C:\Users\VALTER~1\AppData\Local\Temp\claude\C--Users-valteresj-OneDrive-Documentos-Harness\4b42d0e7-e798-4bda-827b-23dd7e32cebb\scratchpad\harness2-src`;
**não execute nada de lá**). Leia `harness2/core/prompts.py` — `propose()`, `_INV_TEMPLATE`, `_DOM_TEMPLATE`,
`GENERALIZE`, `aggregate()`, `compose_round()`, `_KEEP_BASE`, `ANSWER_FREE`, `EVIDENCE_BOUNDARY`, `_SURFACE_*` — e
`recursion.py`, `context.py`, `schedule.py`. Adapte (não copie às cegas) os prompts para a superfície de harness do
Claude Code em `src/shared/harness.ts` (`CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/commands`,
`.claude/settings.json` com hooks, `.claude/scripts`). Marque com "Adapted from google-research/harness2 (Apache-2.0)".

## Novos modos de rodada

Além do modo **Manual** atual, "Nova rodada" ganha:

1. **Automático — paralelo (largura)**, parâmetro `k` (1..2, padrão 1):
   base rodada 1× → `k` proponentes **INV** e `k` proponentes **DOM**, independentes, a partir da evidência da base
   (e da biblioteca) → cada candidato rodado 1× → **compositor** monta UM harness a partir de toda a evidência
   (MERGE, adotar um inteiro, ou KEEP_BASE) → o composto rodado 1× → **seleção cega** entre base, candidatos e composto.
2. **Automático — sequencial (profundidade)**, parâmetro `K` passos (1..3, padrão 2):
   base rodada 1× → para t = 1..K: um INV e um DOM sobre o **checkpoint atual** com todo o histórico → ambos rodados →
   compositor produz o checkpoint t (pode reproduzir um anterior ou manter o atual) → checkpoint rodado (é a evidência
   on-policy do próximo passo) → seleção cega entre base e checkpoints.
   Em ambos, KEEP_BASE é resposta válida em todo estágio; proposta inválida ganha UMA nova tentativa e, se falhar de
   novo, herda o harness atual (como no harness2).

Mostre antes de começar uma estimativa do custo: nº de execuções da tarefa e nº de chamadas de proponente/compositor
(ex.: paralelo k=1 → 4 execuções + 3 chamadas). Ofereça um teto opcional em US$ que interrompe a rodada ao ser
ultrapassado (some `costUsd` das execuções e das chamadas).

## Proponentes e compositor (main)

- Cada chamada é uma query headless do SDK (`loadSdk`, `resolveClaudeExecutable`, `claudeEnv` de `engine/sdk.ts`),
  modelo configurável na rodada (padrão: o modelo padrão das configurações), com um **diretório de contexto** próprio
  em `<userData>/hangar-data/lab/ctx/<rodada>/<estágio>/`:
  `task.md`, `base_harness/**`, `harness/**` (cópia editável do harness atual — é a ÚNICA coisa que o proponente pode
  alterar), `runs/<rótulo>/{trajectory.md, final.md, changes.patch}` (trajetória condensada, resposta, diff limitado),
  `library/` (lições ativas do projeto via `listLessons` e snapshots de origem `lab` como exemplos),
  e, no compositor, `candidates/<rótulo>/harness/**`.
- `cwd` = esse diretório; ferramentas só de leitura e edição de arquivos (Read, Glob, Grep, Write, Edit — **sem Bash,
  sem web**); `canUseTool` nega qualquer escrita fora de `harness/` e qualquer caminho que `isHarnessPath` rejeite
  (relativo a `harness/`). Confira os nomes exatos das opções (`allowedTools`, `disallowedTools`, `canUseTool`,
  `permissionMode`) no `.d.ts` do SDK.
- O proponente/compositor termina com `<notes>…</notes>` (uma linha por decisão, citando o momento da trajetória) ou a
  linha `KEEP_BASE`. A nova árvore = conteúdo final de `harness/` (validado; sem arquivos fora da superfície).
- Prompts INV e DOM separados (cada um não invade o outro), "toda edição precisa apontar um momento da trajetória",
  preferência por divergência > falha repetida > risco visível, fatos do workspace vs procedimento (GENERALIZE),
  "componente nomeado vence prosa", custo do texto sempre carregado, ANSWER_FREE e EVIDENCE_BOUNDARY.
- Guarde por estágio: árvore resultante, notas, custo e duração. Tudo visível na UI **depois** da seleção cega.

## UI

- "Nova rodada": seletor de modo (Manual | Automático paralelo | Automático sequencial), `k`/`K`, modelo das execuções,
  modelo dos proponentes, teto de custo, estimativa.
- Detalhe da rodada: linha do tempo do pipeline (Base → Propostas INV/DOM → Execuções → Composição → Execução →
  Seleção cega), com status, custo e tempo de cada estágio e as variantes com nomes neutros durante a rodada
  (sem revelar qual é a base ou o composto antes da escolha). Depois da escolha: notas de cada proponente/compositor
  e o diff de cada harness contra a base.
- Os botões Adotar / Refletir / Limpar continuam; refletir passa todos os candidatos (com `adopted` marcado).

## Pronto quando

Num repositório git temporário com `CLAUDE.md` simples e uma tarefa pequena (modelo das execuções haiku, proponentes
haiku ou sonnet), uma rodada **paralela k=1** e uma **sequencial K=1** completam até a seleção cega; os proponentes só
alteram arquivos de harness; uma proposta inválida simulada cai no retry e depois herda; o teto de custo interrompe
quando ultrapassado (teste com um teto baixo). Limpe tudo no fim (worktrees, branches, sessões de teste em
`~/.claude/projects`). Teste com `--user-data-dir` isolado e porta de depuração livre (não use 9333 nem 19888-19895).
Relatório em `docs/agents/reports/wave5-lab.md`; responda só `PRONTO: wave5-lab`.
