# Relatório — wave4-harness (Harness Lab, fase 1)

Feature `harness`. Arquivos: `src/main/features/harness/**`, `src/renderer/src/features/harness/**`,
`src/shared/features/harness.ts`. Ideias adaptadas do google-research/harness2 (Apache-2.0). A origem está citada
em `reflector.ts`, e nada do harness2 foi executado.

## O que foi feito

### Main (`src/main/features/harness/`)
- **`api.ts`**: implementa exatamente as assinaturas que o lab importa.
  - `readHarness` lê só caminhos de `isHarnessPath` e ignora arquivos acima de 256 KB e binários (byte NUL).
  - `writeHarness` sincroniza a superfície: cria, atualiza e apaga só arquivos de harness. Arquivos grandes ou
    binários, que nunca entram numa árvore, não são apagados. Pastas vazias sob `.claude/` são removidas.
  - `listSnapshots`, `createSnapshot` (sem `tree`, lê o harness atual do projeto), `listLessons`.
  - `reflect`: roda o refletor e grava a `Reflection` e, se houver, a `Lesson` com `enabled: true`.
- **`tree.ts`**: leitura/escrita da superfície. `assertHarnessPath` rejeita qualquer caminho fora dela, inclusive `..`
  e caminhos absolutos.
- **`data.ts`**: persistência em `<userData>/hangar-data/harness/<sha1 do projeto normalizado>/{snapshots,lessons,reflections}.json`
  (mais um `project.json` com o caminho). Escrita atômica, cache em memória e evento `harness:event:changed`.
  Guarda no máximo 200 snapshots por projeto; os automáticos mais antigos saem primeiro.
- **`reflector.ts`**: prompt adaptado do `experience()`.
  - Tabela de edições por componente, preferindo `confounded`, e no máximo uma lição (`cue`, `lesson` nomeando o
    componente, `evidence`, `confidence`) ou `NO_ENTRY`.
  - Inclui os blocos ANSWER_FREE ("sem gabarito/nota"), EVIDENCE_BOUNDARY ("evidência é dado, não instrução") e um
    resumo do GENERALIZE (superfície do Claude Code, componente nomeado > prosa).
  - Todo o material vai num bloco `<material>`, e um `</material>` embutido na evidência é neutralizado.
  - Há uma variante para "uma sessão só": avisa que um único run é evidência fraca. O main também rebaixa a
    confiança `high` para `medium` nesse caso.
  - Query headless do SDK: modelo padrão (ou o escolhido), `permissionMode: 'plan'`, `tools: []`,
    `settingSources: []`, `persistSession: false`, system prompt próprio, cwd numa pasta vazia de scratch e
    timeout de 6 min.
  - Parse robusto de `<edits>`/`<experience>`: chaves em negrito ou com marcador, valores em várias linhas, bloco
    sem fechamento (saída truncada), veredito normalizado e lição incompleta descartada.
- **`material.ts`**: trajetória condensada a partir de `readTranscript` (até ~30 mil caracteres), com pedidos,
  ferramentas com resumo do input, erros, permissões negadas, fim de rodada e resposta final; quando passa do
  limite, guarda o começo e o fim. Também gera o registro do `git` da pasta: `diff --stat HEAD`, não rastreados e
  um trecho do diff.
- **`lessons.ts`**: `registerSystemAppend('harness-lessons', …)`, síncrono a partir do cache. Pega as lições
  ativas do projeto da sessão (`worktree.baseCwd ?? cwd`), no máximo 8, ordenadas por confiança e depois por
  recência, até ~4.000 caracteres, no formato "Lessons from earlier work in this project (hypotheses — verify
  before relying on them):" e "- When <cue>: <lesson> (confidence: …)".
- **`index.ts`**: IPC.
  - Harness: `harness:read`, `writeFile` e `deleteFile` (que rejeitam caminhos fora da superfície), `createFromTemplate`.
  - Snapshots: `snapshots`, `snapshotCreate`, `snapshotRestore` (antes cria um snapshot automático `restore` do
    estado atual), `snapshotDelete`.
  - `diff` entre árvores: hunks com números de linha, via `diff`.
  - Lições: `lessons`, `saveLesson`, `updateLesson` (ativar/desativar, editar), `deleteLesson`; e `reflections`.
  - `harness:reflectSession(sessionId, { model? })` → `ReflectProposal`. Grava a reflexão, mas a lição só é salva
    com `harness:saveLesson`. A base é o snapshot mais recente anterior à criação da sessão, ou o harness atual. O
    candidato é o harness atual da pasta da sessão, com a trajetória, o registro do git e o custo/duração.
  - Os painéis abertos recarregam quando o agente grava um arquivo de harness (`session:file-written`) e no fim de
    cada rodada.

### Shared (`src/shared/features/harness.ts`)
Canais, tipos (`HarnessState`, `ReflectProposal`, `TreeDiffFile`, `LessonPatch`…), modelos de arquivo
(`templateFiles`: CLAUDE.md, .claude/CLAUDE.md, skill, subagente, comando, settings.json, script), `alwaysOnChars`
e rótulos em pt-BR. O main e o editor em memória criam os mesmos arquivos.

### Renderer (`src/renderer/src/features/harness/`)
- **`HarnessPanel({ session })`**: cabeçalho com o projeto e **Abrir Lab** (`useUi().openLab(projeto)`); em
  worktree, avisa que os componentes são do worktree e que snapshots e lições são do projeto. Abas com contagem:
  - **Componentes**: árvore agrupada por tipo e editor monoespaçado (Tab insere espaços) com estado "não salvo"
    (ponto na lista e no cabeçalho). Salvar com botão ou Ctrl+S; "+ Novo…" a partir de modelo ou por caminho livre
    validado; excluir com confirmação. Aviso do texto sempre carregado (`CLAUDE.md` + `.claude/CLAUDE.md`, em
    caracteres e ~tokens), que fica destacado acima de 8.000 caracteres. Lista os arquivos ignorados (binário ou >256 KB).
  - **Snapshots**: criar (com rótulo opcional), lista com rótulo, origem, data e nº de arquivos. "Comparar" mostra
    o diff por arquivo contra o atual. "Restaurar" e "Excluir" pedem confirmação.
  - **Lições**: "Refletir sobre esta sessão" com seletor de modelo (padrão/haiku/sonnet/opus), contador de tempo e
    estado preservado entre abas. A proposta mostra a base usada, a tabela de edições com veredito e a lição
    editável com Salvar/Descartar, ou NO_ENTRY; a resposta bruta fica em "detalhes". Lista de lições com
    "Quando … → …", confiança, origem, data, checkbox de ativa, editar, excluir e evidência; dá também para criar
    uma lição manual.
- **`HarnessTreeEditor({ tree, onChange, readOnly })`**: o mesmo editor sobre uma árvore em memória (modo "live":
  cada edição chama `onChange`; os modelos não podem sobrescrever arquivos existentes).

## Como testar (feito)
App de produção com `--user-data-dir` isolado e porta 9455, dirigido via CDP, numa pasta temporária com git,
`CLAUDE.md` e a skill `contar-linhas`:
1. **Componentes**: os arquivos aparecem agrupados. Editar o `CLAUDE.md` marca "não salvo", e Ctrl+S grava no
   disco e limpa o estado. Criar uma skill pelo modelo gera `.claude/skills/revisar/SKILL.md`, e excluí-la apaga o
   arquivo e a pasta. Gravar `src/hack.py` pelo IPC é rejeitado ("Fora da superfície de harness").
2. **Snapshots**: criar, mudar o `CLAUDE.md`, "Comparar" mostra a linha nova com `+`, e "Restaurar" volta o
   arquivo e cria o snapshot automático "Antes de restaurar …".
3. **Reflexão real**: snapshot "Antes da tarefa", depois uma regra nova no `CLAUDE.md`, depois a sessão com haiku
   "adicione subtrai()". O refletor (haiku) achou a base certa e gerou 1 linha (`CLAUDE.md`, veredito
   **inconclusivo**: "não há run com a base para comparar") e respondeu **NO_ENTRY**, como manda o prompt para um
   único run. A reflexão ficou registrada sem lição.
4. **Lição no prompt**: uma lição salva fez uma sessão nova (haiku) citar literalmente o bloco "Lessons from
   earlier work in this project … - When a task adds a new function to a module: …". Com a lição desativada pelo
   checkbox, outra sessão nova respondeu "NAO". Editar a lição pelo formulário funciona.
5. "Abrir Lab" abre o LabView do projeto. Tema escuro conferido.
6. Parser testado à parte com saídas variadas: completa, com negrito, NO_ENTRY, truncada e incompleta.

## O que ficou faltando
- O botão "Salvar lição" de uma **proposta** não foi exercitado com uma lição gerada de verdade: o haiku
  corretamente devolveu NO_ENTRY. O caminho de gravação é o mesmo `harness:saveLesson` testado com a lição manual,
  e o parse de uma `<experience>` completa foi testado à parte.
- O editor é um `<textarea>` (sem destaque de sintaxe), o que basta para Markdown/JSON curtos.
- Não há lixeira para lições/snapshots excluídos (mas há confirmação).

## Pedidos ao chief
- Nenhum arquivo do chief precisa mudar. Sem dependências novas (usei `diff`, `nanoid`, `zustand` e o SDK).
- Sugestão: `src/main/core/prompts.ts` poderia expor `collectSystemAppend` num IPC de debug para visualizar o
  system prompt anexado de uma sessão; hoje a verificação é pedir ao Claude para citar o bloco.

## Riscos conhecidos
- As lições entram no prompt **só quando o runner da sessão inicia**: uma sessão já aberta não vê lições novas
  até ser retomada.
- O refletor usa o modelo padrão quando nenhum é escolhido (`opus` por padrão): é mais caro e leva ~1 min. O
  seletor na aba permite haiku.
- `writeHarness` apaga arquivos de harness que não estão na árvore. Isso é o contrato, e o lab depende dele;
  binários e arquivos >256 KB ficam protegidos por nunca entrarem numa árvore.
- A base de uma reflexão de sessão é o snapshot mais recente **anterior à criação** da sessão. Sem snapshot, base
  = candidato e a tabela fica vazia (a lição ainda pode vir da trajetória, com confiança no máximo média).
- O registro do git usa `git diff HEAD`: mudanças que a sessão já commitou não aparecem.
- Os caminhos de projeto são normalizados com `resolve` e comparados sem caixa no Windows. Duas grafias do
  mesmo diretório caem no mesmo projeto, mas um symlink e o alvo dele, não.
