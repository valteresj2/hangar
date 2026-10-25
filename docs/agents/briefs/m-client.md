# Modelos sincronizados (app): perfis gerenciados e seletor Assinatura × Modelos de token

Regras de `docs/agents/RULES.md`. Você é o mesmo agente do feature `platform` (Fase 1). Especificação:
`docs/platform/app-api-models.md`. O chief já acrescentou a `ProviderProfile` (`src/shared/providers.ts`) os campos
opcionais `managedBy?: 'platform'` e `platformConnectionId?: number`.

**Exceções desta missão** (a plataforma está sendo alterada em paralelo pelo agente `platform`; ninguém mais mexe no app):
você pode editar `src/main/features/settings/providers.ts` e a seção Provedores do renderer (perfis gerenciados
somente leitura), o composer e a barra do engine (`src/renderer/src/features/engine/**`, só o seletor de modelo/
provedor), a `NewSessionView` e o Quick Entry (só o seletor) e Configurações → Geral (padrão). IPC sempre tipado.
Sem `npm install`.

## Entregas

1. **Sincronização** no feature `platform`: `GET /api/app/models` ao conectar, a cada 15 min, ao voltar do sleep
   (`powerMonitor`) e por um botão "Sincronizar agora"; chave `ahl_…` do dispositivo via
   `POST /api/app/devices/{id}/llm-key`, guardada cifrada (segredo) e rotacionada se o proxy devolver 401 uma vez.
2. **Perfis gerenciados**: um por conexão sincronizada (`kind: 'gateway'`, `baseUrl` do proxy, `authStyle: 'bearer'`,
   `managedBy: 'platform'`, `platformConnectionId`, `models` com padrão e extras), criados/atualizados/removidos a cada
   sincronização pelas funções de `settings/providers.ts` (sem duplicar a lógica de segredo). Somente leitura na UI
   (sem editar/excluir; mostram "gerenciado pela plataforma"). Desconectar ou a conexão sair da lista → perfil removido e
   sessões que o usavam passam para a assinatura com um aviso na transcrição.
3. **Seletor único de modelo** (composer, nova sessão, Quick Entry): grupos **Assinatura** (aliases e modelos da
   assinatura), **Modelos de token · <conexão>** (nome, contexto, preço por 1M tokens) e **Outros perfis** do usuário.
   Escolher grava `providerId` + `model`; trocar no meio da sessão usa o mecanismo existente (encerra o runner e retoma).
   Rodapé mostra a origem ("Assinatura" ou "Token · <conexão>") e o custo "estimado" nos modelos de token.
   Configurações → Geral: modelo/origem padrão.
4. **Testes**: unitários (mapeamento conexão→perfil, remoção, fallback para a assinatura) e e2e com a plataforma falsa
   do app (`tests/mock-platform/`, acrescente `/api/app/models`, `llm-key` e um proxy que encaminha para o
   `tests/mock-anthropic/`): sincronizar → escolher um modelo de token no seletor → resposta em streaming pelo proxy →
   desligar a sincronização na plataforma falsa → perfil some e a sessão cai para a assinatura.
5. **Integração real** (opcional, quando o agente `platform` deixar a instância 8091 com o proxy e o upstream falso
   rodando — veja `docs/agents/reports/m-platform.md`): estender o e2e opt-in `platform-real.spec.ts`. Nunca use
   `http://localhost:8090`.

Verificação: `format:check`, `lint` (0 erros), `typecheck`, `typecheck:tests`, `npm test`, `npm run test:e2e`.
Relatório em `docs/agents/reports/m-client.md`; responda só `PRONTO: m-client`.
