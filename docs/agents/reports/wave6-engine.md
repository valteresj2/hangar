# Relatório — engine, sexta onda (sessões por provedor)

## O que foi feito

### 1. `engine/sdk.ts` — um único ponto de lançamento
- `claudeLaunch(providerId?)` → `{ options, defaultModel, secrets }`.
  - `options = { pathToClaudeCodeExecutable, env, settings? }`, com
    `env = process.env − launch.unset + launch.env + CLAUDE_AGENT_SDK_CLIENT_APP` e
    `settings = { env: launch.settingsEnv }` quando `settingsEnv` não está vazio.
  - `secrets` são os valores de variáveis com nome de segredo (`KEY`, `TOKEN`, `SECRET`…), usados só para mascarar
    mensagens.
- `claudeLaunchOptions(providerId?)` devolve só as opções, para espalhar na query. O comentário no topo do arquivo diz que
  outros features devem preferir essa função, porque `claudeEnv()` sozinho perde o override de `settings.env`.
- `claudeEnv(providerId?)` continua existindo e funciona sem argumentos (perfil padrão). `lab` e `harness` não
  precisaram de mudança.
- A sondagem de slash commands (`probeCommands`) usa o perfil da sessão, com cache por perfil + pasta. O runner também
  lança por esse helper.

### 2. Runner
- Perfil efetivo: `session.providerId` → `settings().defaultProviderId` → `subscription`.
- Flag settings do perfil combinadas com `fastMode`; `applyFlagSettings` de esforço/fast mode não mexe no `env`.
- Modelo: `session.model` → `launch.defaultModel` → `settings().defaultModel`.
- A entrada `result` grava `model` (vindo do init), `providerId`, `providerName` e `providerKind`.

### 3. Trocar de provedor
- IPC `engine:providers` (lista sem segredos; se o settings não listar nada, entra a assinatura embutida) e
  `engine:setProvider(sessionId, providerId)`.
- A troca grava `session.providerId`, encerra o runner e registra na transcrição: "Provedor alterado para … A conversa
  continua com o mesmo histórico, mas o cache de prompt recomeça". A próxima mensagem retoma (`resume`) com o novo
  perfil. É recusada durante uma geração.
- No composer: seletor "⛁ <perfil>", desabilitado durante a geração, com dica sobre o cache. A lista recarrega quando
  as configurações mudam, quando Configurações fecha e quando a janela ganha foco.

### 4. Modelos do perfil e rodapé
- O seletor de modelo mostra os aliases com o mapeamento do perfil (ex.: "Opus · <id mapeado>"), o padrão do perfil e
  os `extra`, além de "Outro…".
- O rodapé mostra "<modelo> · <perfil>". Para perfis que não são `subscription`, o custo vem como
  "US$ … (estimado)", com uma dica de que é o preço de lista da Anthropic.

### 5. Erros de provedor
- Nova entrada `kind: 'provider_error'` com cartão: nome do perfil, mensagem mascarada e botão "Abrir Provedores"
  (`useUi().setSettingsOpen(true)`).
- Medi o CLI antes de decidir: com credencial recusada (401/403) ou endpoint fora do ar, ele faz 10 novas tentativas e
  só falha depois de cerca de 3 minutos. Por isso:
  - **Credenciais recusadas** (`api_retry` com `authentication_failed`/401/403): cartão na hora e, em perfis que não são
    a assinatura, a rodada é interrompida ("o provedor recusou as credenciais deste perfil"), com status `error`. Na
    assinatura só o cartão aparece, porque o login pode se renovar.
  - **Sem conexão** (`api_retry` sem status HTTP, a partir da 3ª tentativa): cartão de aviso "o Claude Code continua
    tentando (3/10)… pare a rodada se a configuração estiver errada", sem interromper.
  - **Falha final** da rodada ou do processo com texto de autenticação, conexão ou endpoint (401/403/404, ECONNREFUSED,
    ENOTFOUND, "invalid api key", "model not found"…): cartão com a mensagem real.
  - Falha ao resolver o perfil (ex.: segredo ausente) num perfil que não é a assinatura vira o mesmo cartão.
- Mascaramento: os valores secretos do lançamento, `sk-…`, `Bearer …` e `x-api-key`/`token`/`authorization=…`; a
  mensagem é truncada em 600 caracteres.

## Como foi testado (app real)
Cópia isolada da árvore atual (inclui a implementação de perfis do agente settings), `--user-data-dir` isolado,
porta 24683, pasta temporária fora do repo, dirigido por CDP. Só usei token falso (`sk-test-hangar-0000`):
- Perfil "Gateway 401 (teste)": um servidor local de teste respondendo 401 no formato da API.
- Perfil "Gateway offline (teste)": `http://127.0.0.1:9`.
- Ambos criados pelo IPC do settings. O token não aparece em claro nos arquivos de perfis.

Passos:
1. **Assinatura**: "Lembre a palavra GIRASSOL" respondeu normal; rodapé "claude-haiku-5-5 · Assinatura Claude…", sem
   "estimado".
2. **Troca para o Gateway 401** pelo seletor: apareceu a linha de aviso. O seletor de modelo passou a oferecer
   "claude-haiku-test (padrão do perfil)" e "gpt-teste-1". Ao enviar, o cartão "Falha no provedor: Gateway 401
   (teste) — O provedor recusou as credenciais (HTTP 401)" chegou em cerca de 1,3 s; a rodada foi interrompida, o
   status ficou `error` e o rodapé mostrou "(estimado)".
3. **Troca para o Gateway offline**: o cartão de aviso de conexão chegou em cerca de 2,6 s (tentativa 3/10) e "Parar"
   encerrou a rodada (status `idle`).
4. **Volta para a assinatura**: "Qual palavra eu pedi para lembrar no início?" → "GIRASSOL". A conversa foi retomada
   com o mesmo histórico depois de passar por dois perfis.
5. "Abrir Provedores" abriu Configurações. O token de teste não aparece em transcrição, dados do app nem log.

`npm run typecheck` passa na árvore real inteira. Build da cópia isolada OK.

## O que ficou faltando / limitações
- "Abrir Provedores" abre Configurações, mas não vai direto para a seção Provedores: a seção atual fica num store
  interno do feature settings, que eu não devo importar.
- O aviso de conexão não interrompe a rodada (pode ser só instabilidade); o usuário decide parar. Credencial recusada
  em perfil que não é a assinatura interrompe na hora.
- O custo "estimado" usa o preço de lista que o próprio Claude Code calcula; o Hangar não conhece a tabela do gateway.

## Pedidos ao chief
1. Deep-link para uma seção de Configurações, por exemplo `useUi().openSettings(section?)`, para "Abrir Provedores"
   cair direto em Provedores.
2. Migrar `lab` e `harness` de `{ pathToClaudeCodeExecutable: resolveClaudeExecutable(), env: claudeEnv() }` para
   `...claudeLaunchOptions(providerId)`. Sem o `settings.env`, um `ANTHROPIC_BASE_URL` do `~/.claude/settings.json`
   vence o perfil.
3. Nenhuma dependência nova; nenhum arquivo do chief alterado.

## Riscos e observações
- **Para o settings / chief**: num teste isolado com o SDK, `settings.env = { ANTHROPIC_BASE_URL:
  'https://api.anthropic.com', ANTHROPIC_API_KEY: <falsa> }` ainda respondeu "ok" nesta máquina, que tem
  `ANTHROPIC_BASE_URL` para o gateway local (tokenlens) no `~/.claude/settings.json`. Já `ANTHROPIC_AUTH_TOKEN` +
  base URL inválida falha como esperado. Vale o agente settings conferir se um perfil `anthropic` com chave inválida
  realmente falha (o CLI pode estar usando outra credencial), senão o "Testar" desse tipo dá falso positivo.
- A troca de provedor mantém o histórico do CLI. Com gateways para modelos que não são Claude, blocos antigos
  (thinking assinado, imagens) podem ser rejeitados pelo modelo novo; nesse caso o erro aparece no cartão ou na
  transcrição.
- Limpeza: encerrei o app de teste e o servidor 401 local, removi a cópia isolada (junction desfeita antes; o
  `node_modules` real está intacto) e as sessões de teste em `~/.claude/projects`.
- Fins de linha: edições antigas feitas com Python no Windows tinham deixado arquivos meus em CRLF na árvore de
  trabalho. Normalizei tudo para LF (o `.gitattributes` já normaliza no commit); os arquivos que aparecem como "M" sem
  diff de conteúdo são só isso.
