# Sexta onda: engine (sessões por provedor)

As regras de `docs/agents/RULES.md` valem. Suas pastas são as do feature `engine`.
**Atenção**: o agente `lab` trabalha em paralelo nas pastas dele e importa `claudeEnv` de `engine/sdk.ts` — mantenha
`claudeEnv()` funcionando sem argumentos (pode ganhar parâmetros opcionais).

## Objetivo

Cada sessão roda com um **perfil de provedor** (`Session.providerId`, ou `settings().defaultProviderId`): assinatura,
chave de API da Anthropic, gateway (LiteLLM, OpenRouter…), Bedrock, Vertex, Foundry. Contrato em
`src/shared/providers.ts` (leia `git log -1 -p`). O agente `settings` implementa os perfis e
`resolveProviderLaunch(profileId?)` / `listProviders()` em `src/main/features/settings/providers-api.ts` (hoje stubs —
programe contra as assinaturas).

## O que construir

1. **`engine/sdk.ts`**: um helper único para lançar o Claude Code, por exemplo
   `claudeLaunchOptions(providerId?: string)` → `{ pathToClaudeCodeExecutable, env, settings? }`, onde
   `env` = `process.env` − `launch.unset` + `launch.env` (+ o `CLAUDE_AGENT_SDK_CLIENT_APP` atual) e `settings.env` =
   `launch.settingsEnv` quando não vazio. `claudeEnv(providerId?)` continua existindo (compatível com os chamadores).
   Use-o no runner, na sondagem de slash commands e em qualquer query sua. Documente no topo do arquivo que outros
   features devem preferir `claudeLaunchOptions` (o chief vai migrar `lab` e `harness` na integração).
2. **Runner**: aplique o perfil da sessão; combine `settings` do perfil com o que já existe (ex.: `fastMode`).
   Modelo: se a sessão não tiver modelo, use `launch.defaultModel`, depois o padrão das configurações.
3. **Trocar de provedor numa sessão**: seletor "Provedor" na barra do composer (lista de `listProviders()` via um IPC
   seu, `engine:providers`). Trocar grava `session.providerId`, encerra o runner e a próxima mensagem retoma a conversa
   (`resume`) com o novo perfil. Avise que o histórico continua, mas o cache de prompt recomeça. Desabilitado durante
   uma geração.
4. **Seletor de modelo**: quando o perfil tiver `models`, ofereça os aliases mapeados e os `extra` além dos atuais;
   mostre o nome do perfil ao lado do modelo no rodapé de custo/tokens. Para perfis que não são `subscription`, rotule
   o custo como "estimado".
5. **Erros de autenticação**: quando a rodada falhar por autenticação/401/403/endpoint inválido, mostre um cartão com o
   nome do perfil, a mensagem (sem segredos) e o botão "Abrir Provedores" (abre Configurações; você pode chamar
   `useUi().setSettingsOpen(true)`).

## Pronto quando

Uma sessão com o perfil `subscription` funciona como antes; trocar o provedor de uma sessão para um perfil gateway com
URL inválida (crie-o pelo IPC do settings quando existir, ou simule um `ProviderLaunch` num teste isolado) mostra o
cartão de erro, e voltar para `subscription` retoma a conversa. Nunca use chaves reais. Teste com `--user-data-dir`
isolado e porta de depuração livre (não use 9333 nem 19888-19895). Relatório em `docs/agents/reports/wave6-engine.md`;
responda só `PRONTO: wave6-engine`.
