# Relatório — engine, terceira onda (saída Motion no composer)

## O que foi feito

1. **Contrato**: `SendOptions.output?: OutputMode` (`OutputMode = 'motion'`) em `src/shared/features/engine.ts`.
   `engine:send(id, texto, { output: 'motion' })` e `sendPrompt(sessionId, text, opts?: SendOptions)` (`api.ts`) aceitam
   o modo. A assinatura continua compatível com a da RULES.md (`attachments` segue igual). O preview já pode chamar o
   canal.
2. **Seletor no composer**: "🎬 Saída: Padrão | Motion" na barra do composer. Fica destacado quando ligado, e o
   placeholder passa a pedir a descrição da animação. A escolha vale para todos os envios até desligar e é guardada por
   sessão em `localStorage` (`hangar.engine.output.<sessionId>`). Um rewind restaura o modo com que a mensagem tinha
   sido enviada.
3. **Instruções ocultas** (`motion.ts`): com `output === 'motion'`, a mensagem enviada ao SDK ganha um bloco de texto
   extra no `message.content` (`SDKUserMessage`), depois do texto do usuário:
   `<hangar-output-mode name="motion">` + `MOTION_GUIDE` + lista dos `*.motion.json` da pasta (até 20, com título,
   cenas e duração) + `</hangar-output-mode>`.
   - A lista vem do índice de arquivos da @menção (git ou varredura), que é invalidado a cada arquivo escrito.
   - A transcrição do Hangar guarda só o texto do usuário e `output: 'motion'`. Conferi que o guia não aparece no JSONL.
   - O runner não reinicia.
   - Usei um bloco na **mesma** mensagem, e não uma mensagem separada com `shouldQuery: false`, para que ela continue
     sendo uma única entrada na cadeia do CLI. Assim o rewind/fork da onda 2 continua ancorando certo.
   - O conversor de histórico ignora esse bloco ao ler sessões do CLI.
4. **Selo "🎬 Motion"** no balão das mensagens enviadas com `output: 'motion'`.
5. **Cartão de resultado**: o runner anota os `*.motion.json` escritos ou editados com sucesso (Write/Edit/MultiEdit)
   durante a rodada. No fim da rodada, grava na transcrição uma entrada `kind: 'motion'` por arquivo, com `parseMotion`
   + `totalDuration` aplicados ao arquivo como ficou. Como é uma entrada persistida, o cartão sobrevive a reinícios.
   - Cartão válido: "Motion: <título> · <duração>s · <n> cenas".
   - "Abrir no player" chama `useUi().openSidePanel('artifacts')` e dispara `OPEN_ARTIFACT_EVENT` com `{ path }`. Se o
     painel estava fechado, dispara de novo 120 ms depois, para o `ArtifactsPanel` recém-montado receber.
   - Com erros, o cartão lista os erros e oferece "Pedir correção", que envia uma mensagem pronta com o caminho e os
     erros, com `output: 'motion'`.
6. **Estado vazio**: quatro sugestões clicáveis.
   - "Criar uma animação (Motion)" liga o modo Motion e foca o composer com "Crie uma animação de 20 segundos
     explicando ".
   - As outras três ("Explicar este projeto", "Procurar bugs", "Escrever testes") só preenchem o composer.

## Como foi testado (app real)
Cópia isolada da árvore atual no scratchpad (build próprio, sem mexer no `out/` compartilhado), `--user-data-dir`
isolado, porta 21437, pasta temporária fora do repo, modelo **sonnet**, dirigido por CDP:
1. Estado vazio → "Criar uma animação (Motion)": o seletor foi para Motion (gravado no localStorage) e o composer
   ganhou foco com o texto inicial. Enviei "Crie uma animação de 15 segundos explicando os 3 passos para começar a usar
   o Hangar".
   - O Claude escreveu `3-passos-hangar.motion.json` com Write.
   - O cartão mostrou "Motion: 3 passos para começar no Hangar · 15s · 5 cenas", sem erros de `parseMotion`.
   - O balão mostrou o selo "Motion".
2. "Abrir no player": o painel Artifacts abriu e o evento chegou com o caminho do arquivo (capturado por um listener de
   teste). O preview ainda não tinha o listener nem o player na hora do teste; o arquivo já aparecia na lista dele.
3. "deixe a cena 2 mais lenta": o Claude editou **o mesmo arquivo** com Edit. Os `id`s das cenas e dos elementos ficaram
   idênticos (comparados antes e depois), a cena 2 foi de 3 s para 5 s e o novo cartão mostrou 17 s.
4. Em Saída: Padrão, pedi a criação de `quebrado.motion.json` inválido. O cartão listou os 2 erros do `parseMotion`.
   "Pedir correção" mandou a mensagem com `output: 'motion'`, o arquivo foi corrigido mantendo os ids (`a`, `t`) e o
   novo cartão saiu válido (3 s, 1 cena).

Typecheck limpo nos meus arquivos. O único erro atual da árvore é em `features/preview/ArtifactsPanel.tsx` (falta a chave
`motion`), do trabalho em andamento do preview. Build da cópia isolada OK.

## O que ficou faltando / limitações
- O cartão só aparece quando o arquivo é gravado por Write/Edit/MultiEdit. Se o Claude gerar o arquivo via
  Bash/PowerShell, não há cartão (o arquivo ainda aparece pelo índice nas próximas rodadas).
- Abrir de fato no player depende do listener de `OPEN_ARTIFACT_EVENT` do preview (onda 3 dele).

## Pedidos ao chief
- Nenhuma mudança em arquivos do chief e nenhuma dependência nova.
- Para o preview: o `OPEN_ARTIFACT_EVENT` pode chegar duas vezes seguidas com o mesmo caminho (quando o painel estava
  fechado). Selecionar o mesmo artifact de novo precisa ser idempotente.

## Riscos conhecidos
- O guia vai inteiro em toda mensagem enviada com Motion ligado (cerca de 1,5 mil tokens por mensagem). Se isso pesar,
  dá para mandar o guia completo só na primeira mensagem Motion da conversa.
- `localStorage` é por perfil do app: a escolha "Saída" não acompanha a sessão para outra máquina (o selo e a marca na
  transcrição, sim).
- Limpeza: encerrei o app de teste, removi a cópia isolada (desfazendo a junction antes, com o `node_modules` real
  intacto) e as sessões de teste em `~/.claude/projects`.
