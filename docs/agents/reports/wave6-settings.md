# Relatório — sexta onda, feature `settings` (perfis de provedor e chaves de API)

## O que foi feito

### Main
- **`src/main/features/settings/providers.ts`** (novo): armazenamento, validação, resolução e teste de conexão.
  - Perfis sem segredos em `<userData>/hangar-data/settings/providers.json`. Segredos cifrados com `safeStorage` (DPAPI) em `providers.secrets.json`: base64 do blob `v10…` do Electron, nunca em texto puro. Ao iniciar, os segredos são decifrados para um cache em memória, então `resolveProviderLaunch` é síncrono. Sem `safeStorage.isEncryptionAvailable()`, salvar chave é recusado com explicação, e a UI desabilita o campo e mostra um aviso.
  - O segredo nunca volta ao renderer (só `hasSecret`) e não vai para log, relatório nem erro. `maskSecrets()` troca qualquer segredo salvo e padrões `sk-…`, `Bearer …` e `x-api-key/token=…` por `••••`. Os handlers IPC passam os erros por essa máscara.
  - O perfil embutido `subscription` não pode ser editado nem excluído. Excluir o perfil padrão volta o padrão para `subscription`. Um `providerId` de perfil já excluído cai no padrão e depois na assinatura.
- **`providers-api.ts`**: `listProviders()` e `resolveProviderLaunch(profileId?)` implementados com as assinaturas fixadas. `resolveProviderLaunch` **lança erro** (mensagem segura) quando o perfil exige chave e ela não está salva ou não pode ser decifrada.
- **IPC** (`src/shared/features/settings.ts`): `settings:providersList` (perfis + padrão + `encryptionAvailable` + `userSettingsBaseUrl`), `providerSave`, `providerDelete`, `providerSetSecret`, `providerClearSecret`, `providerSetDefault`, `providerTest`; evento `settings:event:providersChanged`.

### Mapeamento de variáveis (todas conferidas na documentação oficial; nada inventado)

| Tipo | `env` (e `settingsEnv`) | Fonte |
|---|---|---|
| `subscription` | nada; `unset: ['ANTHROPIC_API_KEY']`, como hoje | brief |
| `anthropic` | `ANTHROPIC_API_KEY`=chave, `ANTHROPIC_BASE_URL`=URL do perfil ou `https://api.anthropic.com` | env-vars |
| `gateway` | `ANTHROPIC_BASE_URL`; bearer → `ANTHROPIC_AUTH_TOKEN`, x-api-key → `ANTHROPIC_API_KEY` | llm-gateway-connect ("How the credential variable maps to a header"), LiteLLM, OpenRouter |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_PROFILE`, `ANTHROPIC_BEDROCK_BASE_URL`, chave → `AWS_BEARER_TOKEN_BEDROCK` | amazon-bedrock |
| `vertex` | `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_BASE_URL` (sem segredo: credenciais do gcloud / `GOOGLE_APPLICATION_CREDENTIALS` em variáveis extras) | google-vertex-ai |
| `foundry` | `CLAUDE_CODE_USE_FOUNDRY=1`, `ANTHROPIC_FOUNDRY_RESOURCE` (ou `ANTHROPIC_FOUNDRY_BASE_URL`), chave → `ANTHROPIC_FOUNDRY_API_KEY` ou token → `ANTHROPIC_FOUNDRY_AUTH_TOKEN`; sem chave usa `az login` | microsoft-foundry |
| modelos | `opus/sonnet/haiku` → `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`; `default` → `ProviderLaunch.defaultModel` | model-config |

- Fora do `subscription`, todo perfil coloca em `unset` as variáveis de autenticação, roteamento e modelo de **todos** os tipos que ele não define (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_*`, `CLAUDE_CODE_USE_*`, `*_BASE_URL`, `CLOUD_ML_REGION`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`). Assim um perfil não vaza no outro.
- `settingsEnv` = tudo o que o perfil define, mais `''` para as variáveis gerenciadas que o `~/.claude/settings.json` do usuário define e o perfil não usa. **O segredo também vai em `settingsEnv`**, como o brief pede. Conferi no `sdk.mjs` que a opção `settings` do SDK é aplicada por requisição de controle via stdio (`apply_flag_settings`) e **não** pela linha de comando, então a chave não aparece na lista de processos.
- `extraEnv`: só nomes `^[A-Z][A-Z0-9_]*$`. Os nomes gerenciados e `AWS_REGION`/`AWS_PROFILE` são recusados na gravação e de novo na resolução.
- Validação: URL `http(s)` obrigatória no gateway, projeto obrigatório no Vertex, recurso **ou** URL no Foundry (o recurso não pode ser URL, regra da doc), região e perfil AWS com formato simples.

### Teste de conexão
`loadSdk()` + `resolveClaudeExecutable()` de `engine/sdk.ts`. O `env` é o ambiente herdado menos `unset`, mais `env` e `CLAUDE_AGENT_SDK_CLIENT_APP`. Também passo `settings: { env: settingsEnv }`, o modelo do perfil ou `haiku`, `maxTurns: 1`, `tools: []`, `strictMcpConfig` sem MCPs e `persistSession: false`, com o prompt "Responda apenas: ok". O teste mostra o modelo que respondeu, a latência e a resposta. Em caso de falha, mostra o erro em português (401 → "credencial recusada…", conexão → "sem resposta…") com o segredo mascarado. Endpoints inacessíveis param na 2ª tentativa (`api_retry`) em vez de esperar minutos de backoff; o teto geral é 90 s.

### Renderer
- Nova seção **Provedores** em Configurações (`sections/Providers.tsx`): lista de perfis (nome, tipo, "padrão", "chave salva"), Testar, Definir como padrão, Editar e Excluir (com confirmação). **Novo perfil** com modelos prontos: Anthropic (chave de API), LiteLLM (`http://localhost:4000`), OpenRouter (`https://openrouter.ai/api`), Gateway personalizado, Amazon Bedrock, Google Vertex AI e Microsoft Foundry. Cada um tem os campos do seu tipo, uma ajuda curta e o link "Documentação".
- Campo de segredo `type=password`, nunca preenchido: placeholder "•••• salva — digite para substituir" e botão "Remover chave".
- Modelos: padrão, opus, sonnet, haiku e extras, com a dica sobre nomes de outros fabricantes via LiteLLM/OpenRouter e o aviso de que modelos que não são Claude podem não suportar bem ferramentas, thinking ou imagens. Nos gateways há uma caixa para `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, para quando o gateway responde "Extra inputs are not permitted". Há também o campo de variáveis extras.
- O card do perfil da assinatura mostra o `ANTHROPIC_BASE_URL` que vem do `~/.claude/settings.json`, quando existe.
- **Geral → Claude Code**: nova linha "Provedor padrão" com o nome e o tipo do perfil, um aviso quando o padrão não é a assinatura e o botão "Provedores".

## Verificação
- `npm run typecheck` e `npm run build` sem erros.
- App rodando a partir de uma cópia do build com `--user-data-dir` isolado e `--remote-debugging-port=9477`, dirigido por CDP. Todos os segredos usados são falsos (`sk-test-hangar-0000`, `sk-ant-test-hangar-…`):
  - Perfis criados (gateway, anthropic, bedrock, vertex, foundry), editados (a chave salva continua) e excluídos. Excluir o padrão devolve o padrão para `subscription`. `subscription` não pode ser excluído. Validações recusam `extraEnv` com `ANTHROPIC_API_KEY`, URL `ftp://` e recurso Foundry com URL.
  - `providers.secrets.json` contém só blobs `v10…` (base64): `grep` pela chave dá 0 ocorrências nos dois arquivos. A lista enviada ao renderer não contém a chave, nem o DOM depois de salvar pela UI e reabrir para editar.
  - Teste do gateway com URL inválida (`http://127.0.0.1:9`): falhou em cerca de 3,3 s com "Não foi possível conectar ao endpoint: sem resposta (conexão recusada, DNS ou timeout)", sem segredo na mensagem.
  - Teste do gateway contra um servidor HTTP local que registra os cabeçalhos (mascarados): o modo bearer enviou **só** `Authorization: Bearer sk-te…`, e o modo x-api-key enviou **só** `x-api-key`. Os dois receberam 401, mostrado como "credencial recusada".
  - Teste do perfil Anthropic com chave falsa: "Invalid API key · Fix external API key", com o app iniciado num ambiente limpo (ver riscos).
  - Teste do perfil `subscription`: **respondeu "ok"** (`claude-haiku-5-5`, 5,4 s) com o ambiente desta máquina, que exporta `ANTHROPIC_BASE_URL=https://api.anthropic.com`. Com o ambiente **limpo**, o perfil da assinatura segue o `ANTHROPIC_BASE_URL` do `~/.claude/settings.json` (gateway local "tokenlens", `http://localhost:8787/t/claude-code`), que hoje responde HTTP 502 (o upstream devolve 400). O próprio `claude -p` falha da mesma forma fora do Hangar, então é o comportamento "como hoje" pedido para a assinatura. O card agora mostra essa URL para o usuário entender.
- Instâncias e o servidor de teste foram encerrados. Fora da pasta isolada, só mexi no `~/.claude.json` durante uma investigação; restaurei e conferi (sem `customApiKeyResponses`).

## Achados importantes para o engine e o chief
1. **O ambiente do processo vence o `settings` para `ANTHROPIC_BASE_URL`.** O CLI registra: "Ignoring ANTHROPIC_BASE_URL from userSettings/flagSettings: the environment this session was launched with already sets it… the launch environment takes precedence over settings". Por isso o `env` do `ProviderLaunch` precisa ser aplicado ao processo, e não só o `settingsEnv`. É o que o contrato já prevê.
2. **Hangar rodando dentro de uma sessão do Claude Code** (como nos testes dos agentes) herda variáveis do host (`CLAUDECODE`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_SESSION_ID`, …). Com elas o CLI filho usa a autenticação do host e **ignora `ANTHROPIC_API_KEY`**: um perfil Anthropic com chave falsa respondeu "ok" pela assinatura. Com o ambiente limpo, a chave é respeitada. Isso não afeta o app aberto pelo menu Iniciar.

## Pedidos ao chief
1. Considere limpar no `src/main/index.ts`, ao iniciar, as variáveis de sessão-host do Claude Code herdadas (`CLAUDECODE` e `CLAUDE_CODE_*` de host/sessão listadas acima), para que um Hangar aberto de dentro do Claude Code se comporte como o instalado. Não pus isso no `unset` do perfil porque são variáveis internas não documentadas.
2. Os engines e features que lançam o Claude Code devem usar `resolveProviderLaunch` e tratar o `throw` (perfil sem chave) como erro de autenticação, com o cartão "Abrir Provedores".
3. RULES.md: incluir `listProviders`/`resolveProviderLaunch` em "Contratos entre features" (main), se ainda não estiver.

## Riscos conhecidos
- O perfil `subscription` continua obedecendo ao `~/.claude/settings.json`. Nesta máquina, o gateway "tokenlens" configurado lá está devolvendo 502, e as sessões pela assinatura falham quando o Hangar não herda `ANTHROPIC_BASE_URL` de outro lugar. É configuração do usuário, não do Hangar.
- `ANTHROPIC_API_KEY` com um login claude.ai salvo: no ambiente limpo a chave foi usada (erro "Invalid API key" com a chave falsa). Sem chave real não consegui confirmar a resposta "ok" de uma chave válida.
- Gateways com modelos que não são Claude: o Claude Code avisa que não dá suporte a eles. Ferramentas, thinking, imagens e janela de contexto podem falhar. A UI avisa, e a caixa de betas ajuda com "Extra inputs are not permitted".
- Os segredos ficam presos ao usuário do Windows (DPAPI). Copiar a pasta de dados para outra conta ou máquina faz o perfil acusar "não foi possível decifrar", e a chave precisa ser salva de novo.
- As variáveis extras ficam em texto em `providers.json`; a UI avisa para não colocar segredos ali.
