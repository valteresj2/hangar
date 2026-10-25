# Fase 1 (app): conexão com a plataforma Agent Hangar

Regras de `docs/agents/RULES.md`. **Seu feature: `platform`** (`src/main/features/platform/**`,
`src/renderer/src/features/platform/**`, `src/shared/features/platform.ts`). Exceções desta missão: você pode
(a) acrescentar a seção "Plataforma" em `src/renderer/src/features/settings/SettingsView.tsx` (só a entrada na lista),
(b) acrescentar o passo "Conectar à plataforma" no assistente de `src/renderer/src/features/onboarding/**`,
(c) colocar um indicador de conexão no rodapé da sidebar (`src/renderer/src/features/sessions/Sidebar.tsx`, só a
montagem do seu componente), (d) bloquear a criação de sessões no modo `required` sem conexão (no `NewSessionView` e
no IPC `sessions:create`), e (e) registrar o feature em `src/main/features/index.ts`. Estilos só no seu `*.module.css`
(o agente **design** está refazendo o tema em paralelo — não edite `styles.css`, `shell/*.css` nem CSS de outros
features). Sem `npm install`.

A especificação é `docs/platform/app-api-phase1.md` (contrato com a plataforma). O IPC é tipado: declare canais e
eventos em `src/shared/features/platform.ts` estendendo `IpcInvokeContract`/`IpcEventContract` e use `handle()` no main
(veja `docs/ARCHITECTURE.md`).

## Entregas

1. **Config e política**: `platform.url`/`platform.mode` próprios do feature (em `<userData>/hangar-data/platform/`),
   com precedência da política do Windows (`HKLM` e depois `HKCU` `\Software\Policies\Hangar`, `PlatformUrl`, `Mode`)
   lida com `reg query` (sem módulos nativos). Valores vindos da política aparecem travados na UI.
2. **OAuth loopback (RFC 8252)** no main: descoberta, registro dinâmico (cache do `client_id` por URL), PKCE S256,
   `state`, servidor efêmero em `127.0.0.1:<porta aleatória>/callback` que responde uma página simples
   ("pode fechar esta aba") e se fecha, abertura do navegador do sistema (`openExternalLink`), timeout de 5 min,
   troca do código, **refresh rotativo** (com trava contra refresh concorrente), tokens cifrados com `safeStorage`
   (APIs assíncronas), revogação ao desconectar.
3. **Dispositivo**: `device_id` UUID persistido; registro após o login; heartbeat ao iniciar e a cada 15 min;
   `revoked` → desconecta, apaga tokens e notifica.
4. **Cliente HTTP** da API do app com refresh automático em 401 e erros legíveis em português.
5. **UI**: Configurações → Plataforma (URL, modo, estado, usuário, empresa, times, dispositivo, conectar/desconectar);
   passo do onboarding (pulável no modo híbrido, obrigatório em `required`); indicador na sidebar (avatar/inicial,
   empresa, estado).
6. **Testes**: unitários (PKCE, comparação de estado, leitura de política com saída de `reg query` simulada, rotação
   de refresh) e um e2e com um **servidor OAuth falso** em `tests/` (pode criar `tests/mock-platform/`; o agente qa não
   está ativo) que exercita conectar → me → dispositivo → heartbeat → revogado → desconectado.

## Integração real

O agente da plataforma sobe uma instância de desenvolvimento em `http://localhost:8091` (veja o relatório dele em
`docs/agents/reports/p1-platform.md` quando existir). Quando ela estiver no ar, teste o login de verdade contra ela
(login local com o usuário de teste dele), sem tocar em `http://localhost:8090` (instalação do usuário).

Relatório em `docs/agents/reports/p1-client.md`; responda só `PRONTO: p1-client`.
