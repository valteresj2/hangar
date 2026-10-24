# Sexta onda: settings (perfis de provedor e chaves de API)

As regras de `docs/agents/RULES.md` valem. Suas pastas são as do feature `settings` (veja as ondas anteriores).
**Atenção**: o agente `lab` está trabalhando em paralelo nas pastas dele — não toque nelas.

## Objetivo

Além do login da assinatura, o Hangar passa a aceitar **perfis de provedor**: chave de API da Anthropic, gateways
compatíveis com a API da Anthropic (LiteLLM proxy, OpenRouter, gateway corporativo — é assim que se chega a modelos da
OpenAI, Gemini e outros, já que o Claude Code só fala a Messages API), Amazon Bedrock, Google Vertex AI e Microsoft
Foundry. O contrato está em `src/shared/providers.ts` (leia `git log -1 -p`); `Settings.defaultProviderId` e
`Session.providerId` já existem; a API main que o engine vai chamar está em
`src/main/features/settings/providers-api.ts` (implemente exatamente essas assinaturas).

**Não invente variáveis de ambiente.** Confirme cada nome na documentação oficial do Claude Code antes de usar
(WebFetch): `https://code.claude.com/docs/en/llm-gateway`, `/en/amazon-bedrock`, `/en/google-vertex-ai`,
`/en/microsoft-foundry`, `/en/settings` (seção de variáveis de ambiente) e `/en/model-config`. Para LiteLLM e
OpenRouter, confirme também nas docs deles como apontar o Claude Code (`ANTHROPIC_BASE_URL`, token, modelos).

## Main

1. **Armazenamento**: perfis (sem segredos) em `<userData>/hangar-data/settings/providers.json`; segredos cifrados com
   `safeStorage` do Electron (DPAPI no Windows) em `providers.secrets.json`. Se `safeStorage.isEncryptionAvailable()`
   for falso, recuse salvar segredos e explique. Segredo **nunca** volta ao renderer (só `hasSecret`), nunca vai para
   log, transcrição, relatório ou mensagem de erro (mascare). Cache em memória dos segredos decifrados para o
   `resolveProviderLaunch` ser síncrono.
2. **`resolveProviderLaunch(profileId?)`** → `ProviderLaunch`, por tipo:
   - `subscription`: comportamento atual (só `unset: ['ANTHROPIC_API_KEY']`, nada mais; o `~/.claude/settings.json` do
     usuário continua valendo, inclusive gateways que ele configurou lá).
   - `anthropic`: chave da API; base URL oficial (ou a do perfil) — coloque as variáveis também em `settingsEnv`,
     porque `settingsEnv` vira o override de settings da query e precisa vencer um `ANTHROPIC_BASE_URL` que o usuário
     tenha no `~/.claude/settings.json` (é o caso desta máquina: um gateway local "tokenlens").
   - `gateway`: base URL + token (bearer ou x-api-key conforme `authStyle`) + mapeamento de modelos
     (opus/sonnet/haiku/padrão) nas variáveis documentadas.
   - `bedrock` / `vertex` / `foundry`: as variáveis documentadas (região, projeto/recurso, perfil AWS ou chave).
   - `extraEnv` só com nomes `^[A-Z][A-Z0-9_]*$` e nunca sobrescrevendo as variáveis de autenticação.
   - Sempre limpe as variáveis de autenticação de outros tipos que possam vir herdadas (por exemplo, `ANTHROPIC_API_KEY`
     no perfil gateway com bearer), para um perfil não vazar no outro.
3. **IPC** (em `src/shared/features/settings.ts`): listar, criar, editar, excluir perfis (o `subscription` embutido não
   pode ser excluído), definir/remover segredo, definir padrão, **testar conexão** (uma query headless curta com o
   perfil — `loadSdk`/`resolveClaudeExecutable` de `engine/sdk.ts`, `env` = herdado − `unset` + `env`,
   `settings: { env: settingsEnv }`, modelo do perfil ou haiku, `maxTurns` 1, prompt "Responda apenas: ok" — e mostre
   o modelo que respondeu e a latência, ou o erro com o segredo mascarado).

## Renderer — nova seção "Provedores" em Configurações

- Lista de perfis (nome, tipo, padrão, "chave salva"), botão "Novo perfil" com **modelos prontos**: Anthropic (API key),
  LiteLLM (proxy local, `http://localhost:4000`), OpenRouter, Gateway personalizado, Amazon Bedrock, Google Vertex AI,
  Microsoft Foundry. Cada um com os campos do seu tipo, ajuda curta e link para a doc oficial.
- Campo de segredo tipo senha, nunca pré-preenchido ("•••• salva — substituir"). Botões Testar, Definir como padrão,
  Excluir (com confirmação).
- Mapeamento de modelos (padrão, opus, sonnet, haiku, extras) com dica de que, via LiteLLM/OpenRouter, os nomes podem
  ser de outros fabricantes (ex.: um modelo GPT ou Gemini configurado no proxy), com o aviso de que modelos que não são
  Claude podem não suportar bem ferramentas, thinking ou imagens no harness do Claude Code.
- Em Geral, o status de login passa a mostrar também o provedor padrão.

## Pronto quando

Perfis criados, editados e excluídos; segredo salvo cifrado (confira que o arquivo não contém a chave em texto); o teste
de conexão do perfil `subscription` responde "ok"; um perfil gateway apontando para uma URL inválida falha com erro
claro e o segredo mascarado. Use segredos de teste falsos (ex.: `sk-test-hangar-0000`) — **nunca peça nem use chaves
reais**. Teste com `--user-data-dir` isolado e porta de depuração livre (não use 9333 nem 19888-19895).
Relatório em `docs/agents/reports/wave6-settings.md`; responda só `PRONTO: wave6-settings`.
