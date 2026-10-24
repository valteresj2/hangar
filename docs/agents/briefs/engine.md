# Missão: engine (motor do Claude + chat)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `engine`.
Suas pastas: `src/main/features/engine/`, `src/renderer/src/features/engine/`, `src/shared/features/engine.ts`.

## Objetivo

Fazer o Hangar conversar com o Claude Code através do **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`,
já instalado), **usando o login da assinatura do usuário** que o `claude` CLI já tem
(`C:\Users\valteresj\.local\bin\claude.exe`, versão 2.1.307). Nada de API key.

Antes de codar, leia a documentação oficial do SDK TypeScript (WebFetch):
`https://code.claude.com/docs/en/agent-sdk/typescript` e as páginas ligadas a ela (streaming input, permissions,
sessions, user input / canUseTool). Confira também os tipos em `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`.
Nunca invente nomes de API: o `.d.ts` instalado manda.

## Main (`src/main/features/engine/`)

- Um "runner" por sessão do Hangar, mantendo uma `query()` viva em **modo de entrada por streaming**
  (AsyncIterable de mensagens do usuário) para permitir várias mensagens, interrupção e troca de modo.
- Opções: `cwd` = `session.worktree?.path ?? session.cwd`; `model`, `permissionMode` e esforço vindos da sessão
  (padrões em `settings()`); `resume: session.sdkSessionId` quando existir (grave o `session_id` recebido em
  `db('sessions').patch`); mensagens parciais habilitadas para streaming de texto; `pathToClaudeCodeExecutable`
  = `settings().claudeExecutablePath` ou o `claude` encontrado no PATH (para herdar o login da assinatura).
  Remova `ANTHROPIC_API_KEY` do env repassado para garantir o uso da assinatura.
- Se a sessão tiver `projectId`, anexe as `instructions` do projeto ao system prompt (append, não substituir).
- `canUseTool`: encaminhe o pedido ao renderer (evento) e aguarde a resposta (permitir uma vez, permitir sempre nesta
  sessão, negar com mensagem). Emita `session:needs-input` no bus. Também trate a ferramenta de pergunta ao usuário
  (AskUserQuestion), se o SDK a expuser.
- Status: atualize `session.status` (`working`/`waiting`/`idle`/`error`) e `updatedAt`; marque `unread: true` ao terminar
  se a sessão não estiver ativa (o renderer avisa qual está ativa via IPC `engine:setActive`). Emita os eventos do bus da
  RULES.md, incluindo `session:file-written` quando Write/Edit/MultiEdit concluir com sucesso.
- Transcrição: persista em JSONL em `<userData>/hangar-data/engine/transcripts/<sessionId>.jsonl`. Defina o tipo
  `TranscriptEntry` em `src/shared/features/engine.ts` (mensagem do usuário, texto do assistente, thinking resumido,
  tool_use com input, tool_result, pedido de permissão e decisão, resultado da rodada com custo/tokens/duração, erro).
- Gere o título da sessão a partir do primeiro prompt (truncado) se o título ainda for o padrão.
- Exporte `src/main/features/engine/api.ts` com exatamente as funções da RULES.md.
- IPC: `engine:send`, `engine:interrupt`, `engine:history`, `engine:search`, `engine:respondPermission`,
  `engine:setActive`, `engine:setOptions` (model/effort/permissionMode/fastMode em tempo de execução, quando o SDK permitir),
  `engine:slashCommands` (lista de comandos/skills disponíveis vinda da mensagem de init do SDK).
  Eventos: `engine:event:entry` (nova TranscriptEntry), `engine:event:delta` (texto parcial), `engine:event:permission`,
  `engine:event:status`.
- Em `dispose()`, encerre todas as queries.

## Renderer (`src/renderer/src/features/engine/`) — `ChatView({ session })`

- Transcrição rolável com autoscroll inteligente; markdown (`react-markdown` + `remark-gfm`), blocos de código com
  botão copiar e destaque via `shiki` (carregamento lazy).
- Cartões de ferramenta colapsáveis (nome, resumo do input, resultado). Edit/Write mostram diff inline (`diff`).
  Bash mostra comando e saída. TodoWrite vira uma checklist fixada acima do composer.
- Cartão de permissão inline com Permitir / Permitir sempre / Negar.
- Composer: textarea que cresce, Enter envia, Shift+Enter quebra linha; `/` abre autocomplete de slash commands;
  anexar arquivos (botão e arrastar-soltar, usando `window.hangar.pathForFile`); botão Parar durante a geração.
- Barra do composer: seletor de modelo (`opus`, `sonnet`, `haiku`, `fable` e campo livre), esforço
  (low/medium/high/xhigh/max), modo de permissão (Perguntar / Aceitar edições / Planejar / Auto / Ignorar permissões),
  fast mode. Mudanças gravam na sessão e chamam `engine:setOptions`.
- Rodapé discreto com custo/tokens/duração da última rodada e indicador de contexto, se disponíveis.
- Chame `engine:setActive` quando montar.

## Pronto quando

Dá para abrir uma sessão numa pasta, conversar com streaming, ver ferramentas, aprovar uma permissão, interromper,
fechar e reabrir o app e continuar a mesma conversa (resume). Teste de verdade com um prompt curto
(ex.: "liste os arquivos desta pasta") e registre o resultado no relatório.
