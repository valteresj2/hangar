# Relatório — engine (motor do Claude + chat)

## O que foi feito

### Main (`src/main/features/engine/`)
- `sdk.ts` — carrega o Agent SDK por `import()` dinâmico (o pacote é só ESM; o bundle do main é CJS). Encontra o
  `claude.exe` (`settings().claudeExecutablePath` → PATH → `~/.local/bin`) e monta o env **sem `ANTHROPIC_API_KEY`**.
  Tem a fila assíncrona que mantém a `query()` em modo de entrada por streaming, e `probeCommands(cwd)`, que sobe um
  processo descartável só para ler os slash commands antes da primeira mensagem (com cache por pasta).
- `runner.ts` — um `Runner` por sessão com uma `query()` viva:
  - opções: `cwd` = worktree ou cwd; modelo, esforço e modo de permissão da sessão (com os padrões de `settings()`);
    `resume: sdkSessionId`; `includePartialMessages`; thinking adaptativo resumido; fast mode via `settings.fastMode`;
    instruções do projeto anexadas com `systemPrompt.append`; `allowDangerouslySkipPermissions` para poder trocar para
    "Ignorar permissões" durante a sessão (o modo continua opcional).
  - grava o `session_id` do init em `sdkSessionId`; gera o título a partir do 1º prompt quando o título é o padrão
    ("Nova sessão").
  - `canUseTool`: manda o pedido ao renderer, emite `session:needs-input` (permission/question) e espera a resposta.
    Permitir uma vez / sempre nesta sessão (reaproveita as sugestões do CLI com destino `session`; sem sugestão,
    guarda a ferramenta numa lista local) / negar com mensagem. Trata `AskUserQuestion` (devolve `answers`).
  - status `working`/`waiting`/`idle`/`error` + `updatedAt`, `unread: true` ao terminar se a sessão não estiver ativa,
    eventos `session:status`, `session:turn-ended`, `session:needs-input` e `session:file-written` (Write/Edit/MultiEdit/
    NotebookEdit com sucesso). Se o usuário interrompe, o turno não conta como erro.
  - se o `resume` falhar ("No conversation found"), limpa o `sdkSessionId` e avisa.
  - `setOptions`: grava na sessão e aplica na query viva (`setModel`, `setPermissionMode`, `applyFlagSettings` para
    esforço e fast mode). Quando o CLI muda o modo sozinho (ex.: plano aprovado), a sessão é atualizada.
- `transcript.ts` — JSONL em `<userData>/hangar-data/engine/transcripts/<sessionId>.jsonl`, leitura e busca.
- `registry.ts` — mapa de runners, sessão ativa, estado vivo e histórico. **Sessões importadas do CLI** (com
  `sdkSessionId` e sem transcrição) têm o histórico convertido de `getSessionMessages` do SDK na primeira abertura.
- `api.ts` — `sendPrompt`, `interrupt`, `readTranscript`, `searchTranscripts` (exatamente como na RULES.md).
- `index.ts` — IPC `engine:send|interrupt|history|search|respondPermission|setActive|setOptions|slashCommands|state`;
  sessões que ficaram `working/waiting` após um fechamento voltam a `idle`; uma sessão excluída fecha o processo dela;
  `dispose()` fecha todas as queries.

### Shared (`src/shared/features/engine.ts`)
Canais, `TranscriptEntry` (union: user, assistant, thinking, tool_use, tool_result, permission_request,
permission_decision, result com custo/tokens/duração/contexto, system, error) e os payloads dos eventos
`engine:event:entry|delta|permission|status`. Há também o canal extra `engine:state` (estado vivo para quando o chat é
remontado: pedidos pendentes e texto já transmitido).

### Renderer (`src/renderer/src/features/engine/`) — `ChatView({ session })`
- Transcrição com autoscroll inteligente (segue o fim só enquanto você está no fim; botão ↓) e markdown
  (`react-markdown` + `remark-gfm`), links abrem no navegador do sistema.
- Blocos de código com copiar e destaque `shiki` carregado sob demanda (temas claro/escuro via variáveis CSS).
- Cartões de ferramenta colapsáveis: Edit/MultiEdit/Write com diff inline (`diff`), Bash/PowerShell com comando e
  saída, Read com o conteúdo destacado; ponto de status (rodando/ok/erro).
- Cartão de permissão inline (Permitir / Permitir sempre nesta sessão / Negar com mensagem opcional) e cartão de
  pergunta (AskUserQuestion, com "Outra resposta").
- Checklist fixada acima do composer a partir de `TodoWrite` **ou** `TaskCreate`/`TaskUpdate`.
- Composer: textarea que cresce, Enter envia, Shift+Enter quebra linha, `/` abre autocomplete de comandos/skills,
  anexos por botão e arrastar-soltar (`window.hangar.pathForFile`), Parar (botão ou Esc) e mensagens enfileiradas
  enquanto trabalha. Imagens vão inline (base64, até 5 MB); outros arquivos vão como caminhos no prompt.
- Barra: modelo (opus/sonnet/haiku/fable + "Outro…" livre), esforço, modo de permissão, fast mode → `engine:setOptions`.
- Rodapé: duração, custo, tokens e barra de uso de contexto da última rodada. Chama `engine:setActive` ao montar.

## Como foi testado (de verdade)
Typecheck e build passam. App rodado com `--user-data-dir` isolado e dirigido por CDP, sessão com Haiku numa pasta de teste:
1. "Liste os arquivos desta pasta e depois use Write para criar d.txt…" → streaming, cartões Glob/Write com diff, cartão
   de permissão, cliquei Permitir, arquivo criado, título gerado, `sdkSessionId` gravado, rodapé com custo/contexto.
2. Fechei o app, reabri e perguntei "Qual arquivo você criou?" → respondeu "d.txt com o texto teste hangar" (resume ok).
3. Prompt longo com bloco de código → texto chegando aos poucos, shiki colorindo, Parar → "Interrompido pelo usuário",
   status `idle`.
4. AskUserQuestion → cartão de pergunta, escolhi "Go", o Claude seguiu com a resposta.
5. Negar com mensagem, anexo de arquivo (o Claude leu o anexo), PowerShell com saída, `engine:search`, `setOptions`
   ao vivo, tema escuro, autocomplete de `/` (72 comandos vindos do CLI antes da 1ª mensagem).
6. O init do CLI informa `apiKeySource: "none"` → usa o login da assinatura, sem API key.

Para repetir: `npm run dev`, crie uma sessão numa pasta e mande "liste os arquivos desta pasta"; peça para criar um
arquivo para ver o cartão de permissão; feche e reabra o app e continue a conversa.

## O que ficou faltando / limitações
- Colar imagem da área de transferência (P1) não foi feito: só arquivos com caminho (botão ou arrastar).
- A checklist fixada funciona com TodoWrite/TaskCreate, mas o CLI 2.1.307 **não expõe essas ferramentas no modo SDK**
  (a lista de ferramentas do init não as traz), então hoje ela raramente aparece.
- @menção de arquivo, rewind/fork e side chat (P1/P2) não foram feitos.
- O tráfego de subagentes (Agent/Task) não aparece aninhado; só o resultado final do Agent.
- O custo do rodapé é o acumulado da execução atual do processo (estimativa do SDK); após reiniciar o app ele recomeça.

## Pedidos ao chief
1. `src/main/core/bus.ts`: adicionar à lista de eventos do topo
   `//   'session:file-written' { sessionId, path } — engine (Write/Edit/MultiEdit/NotebookEdit ok)`.
2. CSP de `src/renderer/index.html`: nada obrigatório. O shiki usa o motor JavaScript porque a CSP não permite
   WebAssembly. Se preferirem o Oniguruma (mais fiel), acrescentem `'wasm-unsafe-eval'` a `script-src`. Sem isso, tudo
   já funciona.
3. Nenhuma dependência nova.

## Riscos conhecidos
- `allowDangerouslySkipPermissions: true` vai sempre na query para permitir trocar para "Ignorar permissões" em
  execução; o modo efetivo continua sendo o escolhido pelo usuário.
- "Permitir sempre nesta sessão" reaproveita as sugestões do CLI, que às vezes incluem `setMode: acceptEdits` (o
  mesmo que o Claude Code faz). Nesse caso o seletor de modo da sessão passa para "Aceitar edições".
- Cada sessão aberta e usada mantém um processo `claude.exe` vivo até o app fechar ou a sessão ser excluída.
- Durante o teste, a porta de depuração 9333 já estava em uso por outra instância do Hangar (de outro agente). Meu
  primeiro comando chegou a criar uma sessão de teste (`enginetest1`) nela, que **removi** na hora. Os testes seguintes
  rodaram numa instância isolada (`--user-data-dir` no scratchpad, porta 19777). As sessões de teste que eu tinha criado
  em `~/.claude/projects` também foram removidas.
- Num teste, um pedido de permissão foi aprovado cerca de 26 s depois de aparecer, sem clique meu. Provavelmente foi
  alguém clicando "Permitir" na janela do app, que fica visível na área de trabalho. Nenhum caminho do código aprova
  sozinho.
