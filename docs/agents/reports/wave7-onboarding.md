# Relatório — sétima onda, feature `onboarding` (primeiro uso e diagnóstico do gateway)

## O que foi feito

### Main (`src/main/features/onboarding/`)
- **`onboarding:diagnose`** (`diagnose.ts`) devolve um resultado estruturado. Cada item tem `ok`/`warn`/`error`/`skip`, mensagem em português e uma ação opcional (`applyDirectFix`, `openProviders`, `openUrl`):
  1. **Claude Code**: `resolveClaudeExecutable()` (PATH, `~/.local/bin` ou o embutido) e `--version`. Sem o comando, aviso de que será usado o executável do SDK, com link de instalação.
  2. **Login**: `claude auth status --json` (subcomando conferido no `claude --help`). Nunca pede senha nem token.
  3. **Gateway / endpoint**: `ANTHROPIC_BASE_URL` do `~/.claude/settings.json`, da variável de usuário do Windows (`reg query HKCU\Environment`) e do ambiente do Hangar. Aplica a precedência real do CLI: o ambiente vence o `settings.json`, como o próprio CLI registra no log. Credenciais (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) e `apiKeyHelper` aparecem **só pelo nome**; o valor nunca é lido (no registro só uso o código de saída). As URLs aparecem sem query string.
  4. **Provedor**: `testProvider()` do perfil padrão (ou do perfil da sessão). Se falhar com o perfil embutido `subscription` atrás de um gateway, roda um teste **direto** (`probe.ts`): uma consulta de uma volta com `ANTHROPIC_BASE_URL=https://api.anthropic.com` no `env` e no `settingsEnv`, num perfil temporário só em memória, sem salvar nada. Se o direto passa, o item explica que "o gateway está quebrando a assinatura" e oferece a correção. Se o direto também falha, diz que o problema não é só o gateway.
  5. **Git**: `git --version`, com link de download se faltar.
  - `{ quick: true, providerId }` roda só os itens gateway, provedor e direto (para o botão do cartão de erro).
- **`onboarding:applyDirectFix`** reaproveita um perfil `subscription` do usuário que aponte para a Anthropic (ou sem URL) ou cria **"Assinatura (direto)"** (`kind: 'subscription'`, `baseUrl: https://api.anthropic.com`) com `saveProvider`, define como padrão com `setDefaultProvider` e testa com `testProvider`. **Não altera o `~/.claude/settings.json`**: conferi que o arquivo continua com a data de 21/10 e o mesmo `ANTHROPIC_BASE_URL`.
- **`onboarding:providerSummary`**: nome e tipo do provedor padrão para o passo "Provedor", via `listProviders()`, sem segredos.
- Depois da correção, o item do gateway passa a "ok", explicando que o provedor padrão do Hangar não passa pelo gateway mas o `claude` no terminal continua passando.

### Renderer (`src/renderer/src/features/onboarding/`)
- **`OnboardingView`**: assistente em 5 passos (Boas-vindas → Diagnóstico → Provedor → Pasta inicial → Pronto), com trilha de passos clicável, Voltar/Próximo, **Pular** em qualquer passo (e Esc), tema claro e escuro.
  - Diagnóstico: lista de verificações com ícones, "Rodar de novo" e o botão **"Corrigir: usar a assinatura direta"**. A correção mostra o resultado e roda o diagnóstico de novo.
  - Provedor: resumo do padrão e o link "Abrir Configurações → Provedores" (`useUi().openSettings('providers')`), que marca o onboarding como concluído.
  - Pasta inicial: escolher pela caixa de diálogo, fixar (vai para `pinnedFolders` e `recentFolders`) e desafixar.
  - Pronto: atalhos (Ctrl+K, Ctrl+N, Ctrl+,, Ctrl+` e o Quick Entry configurado), Hangar Motion e Harness Lab, e "Começar a usar" → `onboardingDone: true`.
- **`GatewayFixButton({ sessionId })`**: "Diagnosticar gateway" roda o diagnóstico rápido com o provedor da sessão. Se a correção se aplica, "Usar assinatura direta" chama `applyDirectFix`, troca o provedor da sessão via `engine:setProvider` (o canal do engine) e avisa "Reenvie a mensagem para continuar". Se não se aplica, explica o motivo e oferece "Diagnóstico completo".
- **`openDiagnostics()`** (exportado): reabre o assistente direto no passo Diagnóstico (store `useOnboardingNav` + `onboardingDone: false`). Ao terminar ou pular, o app volta para onde estava (por exemplo, as Configurações).
- **Exceção permitida no brief**: botão **"Rodar diagnóstico"** no card "Claude Code" de `src/renderer/src/features/settings/sections/General.tsx`.

## Verificação
- `npm run typecheck` e `npm run build` sem erros. O `npm run lint` ainda não roda porque o repositório não tem `eslint.config.*` (deve vir com o agente qa).
- App a partir de uma cópia do build, com `--user-data-dir` **novo**, `--remote-debugging-port=9488` e o ambiente limpo das variáveis da sessão-host (como quem abre pelo menu Iniciar):
  - O assistente aparece no primeiro uso.
  - O diagnóstico detectou o tokenlens: "O Claude Code está configurado no ~/.claude/settings.json para passar por um gateway: http://localhost:8787/t/claude-code". O provedor padrão falhou com "HTTP 502: erro no servidor do provedor/gateway"; o direto na Anthropic passou (3,4 s); Claude Code 2.1.307, login "assinatura Claude (max)" e git ok.
  - "Corrigir" criou "Assinatura (direto)", definiu como padrão e o teste passou ("respondeu em 3,8 s"). O diagnóstico de novo deu tudo ok.
  - Os passos Provedor, Pasta inicial e Pronto renderizam; "Começar a usar" grava `onboardingDone: true` e, depois de recarregar, o assistente não aparece.
  - Configurações → Geral → **Rodar diagnóstico** reabriu no passo "2 Diagnóstico"; "Pular" voltou para "Geral" com `onboardingDone: true`. Com `onboardingDone: false` o assistente volta; "Pular" encerra e não aparece de novo depois de recarregar.
  - Caminho do `GatewayFixButton` por IPC (o botão só vai aparecer quando o chief o colocar no cartão do engine): com a sessão em `subscription`, o diagnóstico rápido deu `gateway:warn, provider:error, direct:ok` com `fixAvailable` em cerca de 7,9 s; `applyDirectFix` **reaproveitou** o perfil (sem duplicar); `engine:setProvider` trocou o `providerId` da sessão.
  - Tema escuro conferido no passo de diagnóstico.
- Instâncias encerradas. Os testes usaram só a pasta de dados isolada; nenhum arquivo do usuário foi alterado.

## Pedidos ao chief
1. Coloque `<GatewayFixButton sessionId={…} />` no `ProviderErrorCard` do engine, pelo menos quando o perfil da rodada for `subscription`. O componente sozinho decide se a correção se aplica.
2. Opcional: a paleta (Ctrl+K) pode ganhar a ação "Rodar diagnóstico" chamando `openDiagnostics()` de `features/onboarding`.
3. Repetindo o pedido da sexta onda: se o Hangar for aberto de dentro de uma sessão do Claude Code, ele herda variáveis da sessão-host (`CLAUDECODE`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `ANTHROPIC_BASE_URL=https://api.anthropic.com`, …), que mascaram o problema do gateway: o perfil `subscription` passa porque o ambiente herdado aponta direto para a Anthropic. Limpar essas variáveis no `src/main/index.ts` deixaria o diagnóstico igual ao do app instalado.

## Riscos conhecidos
- O diagnóstico completo faz uma ou duas consultas reais curtas, com o modelo `haiku` e "Responda apenas: ok": custa alguns tokens da assinatura e leva de 4 a 10 s. Um endpoint inacessível é cortado na 2ª tentativa, com teto de 90 s.
- A leitura da variável de usuário só existe no Windows (`reg query`). Em outros sistemas vale o ambiente do processo e o `settings.json`.
- O teste "direto" replica o que um perfil `subscription` com URL da Anthropic recebe (`env` + `settingsEnv`, sem `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`), mas não usa o `resolveLaunch` do settings, porque ele só aceita perfis salvos. Se o settings mudar essa resolução, o `probe.ts` precisa acompanhar.
- A correção muda o **provedor padrão** do Hangar (é o que o brief pede). Sessões com outro `providerId` explícito não mudam, exceto a sessão do `GatewayFixButton`.
