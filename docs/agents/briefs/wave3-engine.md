# Terceira onda: engine (saída Motion no composer)

As regras de `docs/agents/RULES.md` continuam valendo. Suas pastas são as mesmas da primeira onda.

## Contexto

Hangar Motion é a nossa versão do Claude Motion: animações curtas em `*.motion.json`, desenhadas por código e tocadas
no painel Artifacts (o agente preview constrói player, editor e exportação nesta mesma onda). A base está no commit mais
recente (`git log -1 -p`): `src/shared/motion/spec.ts`, `src/shared/motion/guide.ts` (`MOTION_GUIDE`, o guia que o
Claude precisa receber), `src/renderer/src/motion/runtime.ts` e `docs/motion/example.motion.json`.

## O que construir

1. **Contrato**: `engine:send` e `sendPrompt` (em `src/main/features/engine/api.ts`) aceitam `opts.output?: 'motion'`.
   Declare o tipo em `src/shared/features/engine.ts`. O preview vai chamar `engine:send(id, texto, { output: 'motion' })`.
2. **Seletor no composer**: "Saída: Padrão | Motion" (ícone de claquete/filme). Com Motion ligado, o próximo envio
   (e os seguintes, até desligar) vai com `output: 'motion'`. Guarde a escolha por sessão (localStorage basta).
3. **Instruções para o Claude**: quando `output === 'motion'`, entregue o `MOTION_GUIDE` ao Claude nessa rodada sem
   mostrá-lo na transcrição. Escolha o mecanismo documentado no `.d.ts` do SDK (por exemplo, um bloco de texto extra na
   mensagem do usuário enviada ao SDK, envolvido em `<hangar-output-mode name="motion">…</hangar-output-mode>`, enquanto a
   transcrição do Hangar guarda só o texto do usuário e uma marca `output: 'motion'`). Não reinicie o runner por causa disso.
   Inclua também, nessa rodada, a lista de `*.motion.json` já existentes na pasta da sessão (até 20), para o Claude
   editar em vez de criar outro quando o pedido for de ajuste.
4. **Balão do usuário**: mostre um selo "Motion" nas mensagens enviadas com `output: 'motion'`.
5. **Cartão de resultado**: quando uma rodada escrever/editar um `*.motion.json`, mostre no chat um cartão
   "Motion: <título> · <duração>s · <n> cenas" (leia e valide com `parseMotion`), com o botão "Abrir no player", que
   chama `useUi().openSidePanel('artifacts')` e dispara `window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT,
   { detail: { path } }))`. Se `parseMotion` devolver erros, mostre-os no cartão e ofereça "Pedir correção", que envia
   uma mensagem pronta com os erros (com `output: 'motion'`).
6. **Atalho no estado vazio**: na transcrição vazia, sugestões clicáveis, entre elas
   "Criar uma animação (Motion)", que liga o modo Motion e foca o composer com um texto inicial.

## Pronto quando

Com Motion ligado e o modelo `sonnet`, o pedido "Crie uma animação de 15 segundos explicando os 3 passos para começar a
usar o Hangar" gera um `.motion.json` válido (`parseMotion` sem erros), o cartão aparece e "Abrir no player" abre o
painel Artifacts nele. Um pedido de ajuste ("deixe a cena 2 mais lenta") edita o mesmo arquivo, mantendo os `id`s.
Teste com `--user-data-dir` isolado, numa pasta temporária fora do repo, e uma porta de depuração livre (não use 9333 nem
19888-19892). Relatório em `docs/agents/reports/wave3-engine.md`; responda só `PRONTO: wave3-engine`.
