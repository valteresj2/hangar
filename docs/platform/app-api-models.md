# Contrato App Hangar ↔ Agent Hangar — Modelos de token sincronizados

Fonte única (copiado para `central_agents/docs/app-hangar-models.md`). Depende da Fase 1 (`/api/app`, escopo `app`,
`AppDevice`). Mudanças só pelo chief.

## Objetivo

O admin decide, na página **Provedores de LLM** do console (`/ui`), quais conexões têm os modelos **sincronizados com o
Hangar desktop**. No app, cada pessoa escolhe por sessão entre os modelos da **assinatura** (login do Claude Code) e os
**modelos de token** da plataforma. **A chave da conexão nunca sai da plataforma**: o app fala com um proxy da plataforma,
que injeta a credencial do cofre, aplica as regras da empresa e registra uso e custo.

## Regras

- Só conexões com `protocol = "anthropic"` (API da Anthropic ou gateway compatível com `/v1/messages`, ex.: LiteLLM/
  OpenRouter no formato Anthropic) podem ser sincronizadas — é o único formato que o Claude Code fala. As outras aparecem
  no console com a opção desabilitada e a explicação.
- O Hangar manda código e saídas de terminal: se a empresa usa `code_policy = "approved"`, a conexão precisa de
  `allow_code = true` para ser sincronizada (o console explica e o proxy recusa).
- Só modelos `kind = "text"` e `available = true` da conexão. O admin pode **esconder** modelos específicos do app.
- Orçamento do time com `budget_enforce` estourado → o proxy responde 429 (mensagem em português).

## Plataforma

### Modelo de dados (migração)

- `LlmConnection.sync_desktop: bool = False` — o botão da página de provedores.
- `LlmConnection.desktop_hidden_models: list[str] = []` — modelos escondidos do app.
- Chave de LLM por dispositivo: `AppDevice.llm_key_hash`, `llm_key_prefix`, `llm_key_created_at` (só o hash; o valor
  aparece uma vez). Prefixo do valor: `ahl_`. Revogar o dispositivo, desligar a pessoa ou revogar o grant invalida a chave.

### Console (página Provedores de LLM, `static/llm.js`)

Em cada conexão (cartão e detalhe), um botão/alternador **"Sincronizar modelos de token com o Hangar desktop"**
(admin), com: estado, quantos modelos vão para o app, lista dos modelos com "mostrar/esconder no app", e o motivo
quando não pode (protocolo diferente de `anthropic`, ou `allow_code` exigido). Na aba App Hangar → Visão geral, um
resumo "Modelos sincronizados: N conexões, M modelos".

### API do app (`/api/app`, Bearer OAuth escopo `app`)

| Método e rota                               | Corpo | Resposta                                                                                                                                                                                                                                   |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/app/models`                       | —     | `{version, connections:[{id, name, provider, base_path:"/api/app/llm/<id>", models:[{model_id, name, context_length, caps, price_in_per_mtok, price_out_per_mtok}]}]}` (só sincronizadas e permitidas; `version` muda quando a lista muda) |
| `POST /api/app/devices/{device_id}/llm-key` | —     | `{key:"ahl_…", prefix, created_at}` — gera ou **rotaciona** a chave do dispositivo (a anterior deixa de valer)                                                                                                                             |

### Proxy de LLM (`/api/app/llm/{connection_id}/…`)

- Autenticação: `Authorization: Bearer ahl_…` **ou** `x-api-key: ahl_…` (o Claude Code usa um dos dois). A chave
  identifica pessoa + dispositivo; dispositivo `revoked` ou pessoa inativa → 401.
- `POST /v1/messages` (com e sem `stream`), `POST /v1/messages/count_tokens`, `GET /v1/models` (só os modelos
  visíveis da conexão). Repassa corpo e cabeçalhos relevantes (`anthropic-version`, `anthropic-beta`) para
  `connection.base_url`, com a credencial do cofre no formato que a conexão usa; streaming SSE repassado sem buffer.
- Recusa modelo fora da lista visível (400 com a lista), conexão não sincronizada (403), regra de código (403) e
  orçamento (429).
- Registra `UsageEvent` (pessoa, time, dispositivo, conexão, modelo, tokens de entrada/saída/cache, custo pelo preço do
  modelo ou da conexão, `client = "hangar-desktop"`), contando no orçamento do time. Auditoria só de metadados (nunca o
  conteúdo).
- Limites: timeout longo para streaming; tamanho de corpo compatível com contexto grande.

## App (Hangar)

- O feature `platform` busca `GET /api/app/models` ao conectar, a cada 15 min e ao voltar do sleep; gera a chave
  `ahl_…` do dispositivo e a guarda cifrada (é segredo).
- Para cada conexão sincronizada, mantém um **perfil de provedor gerenciado** (`src/shared/providers.ts`):
  `kind: "gateway"`, `name: "Plataforma · <conexão>"`, `baseUrl: <plataforma>/api/app/llm/<id>`, `authStyle: "bearer"`,
  segredo = chave do dispositivo, `models` = modelos visíveis (o primeiro como padrão), `managedBy: "platform"`,
  `platformConnectionId`. Perfis gerenciados são **somente leitura** em Configurações → Provedores e somem quando a
  conexão deixa de ser sincronizada ou a pessoa desconecta (sessões que os usavam caem para a assinatura com aviso).
- **Escolha no composer**: um seletor único de modelo, agrupado em **Assinatura** (opus, sonnet, haiku…) e
  **Modelos de token · <conexão>** (os modelos sincronizados, com contexto e preço), e os demais perfis do usuário.
  Escolher grava `providerId` + `model` na sessão. Nova sessão e Quick Entry usam o mesmo seletor; Configurações →
  Geral permite definir o padrão.
- Custo exibido como "estimado" no app; o oficial é o da plataforma.
