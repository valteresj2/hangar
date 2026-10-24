# Sétima onda: onboarding (primeiro uso e diagnóstico do gateway)

Regras de `docs/agents/RULES.md`. **Seu feature: `onboarding`** (`src/main/features/onboarding/**`,
`src/renderer/src/features/onboarding/**`, `src/shared/features/onboarding.ts`). Exceção: você pode acrescentar um
botão "Rodar diagnóstico" em `src/renderer/src/features/settings/sections/General.tsx`. Outros três agentes trabalham
em paralelo (qa, security, release) — não toque nas pastas deles. Sem `npm install`.

O chief já preparou: `Settings.onboardingDone` (padrão `false`); o `App` mostra `OnboardingView` em tela cheia
enquanto ele for falso; o export `GatewayFixButton({ sessionId })` (o chief vai colocá-lo no cartão de erro de provedor
do engine). No main você pode importar de `src/main/features/settings/providers.ts` as funções de salvar perfil,
definir padrão e testar conexão, e `resolveClaudeExecutable` de `engine/sdk.ts`.

## Contexto real desta máquina

O `~/.claude/settings.json` do usuário define `ANTHROPIC_BASE_URL` para um gateway local ("tokenlens", em
`localhost:8787`). Com o login próprio do Claude Code ele devolve 400/502; direto na Anthropic funciona. O perfil de
provedor do tipo `subscription` criado pelo usuário com `baseUrl: https://api.anthropic.com` ("Assinatura (direto)")
resolve. O onboarding precisa **detectar e explicar** isso e oferecer a correção em um clique — sem alterar o
`settings.json` do usuário.

## Main — `onboarding:diagnose`

Resultado estruturado (cada item: ok/aviso/erro, mensagem em português, ação sugerida):
1. Claude Code: executável encontrado (PATH, `~/.local/bin` ou o embutido) e versão.
2. Login: status de autenticação do CLI (descubra o subcomando em `claude --help`; não peça senha nem token).
3. Gateway no `~/.claude/settings.json` (e na variável de ambiente do usuário): `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_AUTH_TOKEN`/`API_KEY` presentes (nunca mostre valores de segredo; a URL pode aparecer).
4. Teste do provedor padrão; se falhar e houver gateway, teste também "direto" (perfil temporário em memória, sem
   salvar) para diagnosticar "o gateway está quebrando a assinatura".
5. Git disponível (worktrees e Lab dependem dele).
`onboarding:applyDirectFix` cria (ou reaproveita) o perfil "Assinatura (direto)" e o define como padrão.

## Renderer — `OnboardingView`

Assistente em passos, visual consistente com o app, claro/escuro: Boas-vindas → Diagnóstico (com "Corrigir" quando
houver correção) → Provedor (resumo do padrão; link para Configurações → Provedores via
`useUi().openSettings('providers')`, marcando o onboarding como concluído) → Pasta inicial (escolher e fixar) →
Pronto (atalhos principais, Motion, Harness Lab) → `onboardingDone: true`. "Pular" em qualquer passo.
`GatewayFixButton({ sessionId })`: roda o diagnóstico rápido do gateway; se a correção se aplicar, "Usar assinatura
direta" aplica, troca o `providerId` da sessão para o novo perfil e avisa para reenviar a mensagem.

## Pronto quando

Num `--user-data-dir` novo o assistente aparece; o diagnóstico detecta o tokenlens desta máquina e a correção cria o
perfil e faz o teste passar; "Pular" não volta a mostrar; "Rodar diagnóstico" em Configurações → Geral reabre o passo
de diagnóstico. Porta de depuração livre (não use 9333 nem 19888-19896). Relatório em
`docs/agents/reports/wave7-onboarding.md`; responda só `PRONTO: wave7-onboarding`.
