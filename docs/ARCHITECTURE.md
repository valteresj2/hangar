# Arquitetura do Hangar

Electron (main + preload sandboxed) + React no renderer, organizado em **features** que conversam por contratos
tipados.

## Pastas

| Onde                                    | O quê                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/shared/contracts.ts`               | Tipos de domínio (`Session`, `Project`, `Settings`…) usados por main, preload e renderer.   |
| `src/shared/ipc.ts`                     | Contrato de IPC (canais, argumentos, resultados, eventos) e o transporte `HangarBridge`.    |
| `src/shared/features/<feature>.ts`      | Nomes de canais e tipos de payload do feature, mais a parte dele no contrato de IPC.        |
| `src/shared/harness.ts`, `providers.ts` | Contratos transversais (harness/Lab e perfis de provedor).                                  |
| `src/main/core/`                        | Store, bus, IPC tipado (`handle.ts`), guarda de IPC, janelas e provedores de system prompt. |
| `src/main/features/<feature>/`          | Lado main do feature: `index.ts` (registro) e, se outros features o usam, `api.ts`.         |
| `src/renderer/src/core/`                | `bridge`/`api` tipados, hooks do store (`data.ts`) e estado de UI (`ui.ts`).                |
| `src/renderer/src/features/<feature>/`  | Lado renderer do feature; `index.tsx` exporta o que App/TopBar/SidePanel montam.            |

## Features

Cada feature do main é um `Feature` (`src/main/core/feature.ts`) com `register(ctx)` e `dispose()`, listado em
`src/main/features/index.ts`: sessions, engine, terminal, git, preview, settings, harness, lab, onboarding, updater, platform.
Um feature só importa de outro o seu `api.ts` (ex.: `engine/api.ts` → `sendPrompt`, `readTranscript`;
`git/api.ts` → `createWorktree`; `harness/api.ts` → `readHarness`, `createSnapshot`, `reflect`;
`platform/api.ts` → `canCreateSessions`, `assertCanCreateSessions` — todo ponto que cria sessão passa por eles).

## IPC tipado

1. **Contrato.** `src/shared/ipc.ts` define `IpcInvokeContract` (canal → `(...args) => resultado`) e
   `IpcEventContract` (evento → payload; `void` quando não há). Cada feature acrescenta os seus por _declaration
   merging_:

   ```ts
   // src/shared/features/git.ts
   declare module '../ipc' {
     interface IpcInvokeContract {
       [GIT.status]: (cwd: string) => GitStatus
     }
     interface IpcEventContract {
       [GIT.changed]: GitChangedEvent
     }
   }
   ```

2. **Main.** `handle(canal, (event, ...args) => resultado)` em `src/main/core/handle.ts` só aceita canais do
   contrato, com os argumentos e o resultado (ou Promise dele) certos. Eventos saem por `broadcast(evento, payload)`
   (todas as janelas) ou `sendTo(webContents, evento, payload)`. `handle` usa `ipcMain.handle`, então a guarda
   (`ipcGuard.ts`) continua recusando qualquer remetente que não seja o frame principal do renderer.
3. **Renderer.** `bridge.invoke(canal, ...args)` e `bridge.on(evento, listener)` em `src/renderer/src/core/api.ts`,
   sobre o transporte `window.hangar` do preload. Os resultados vêm tipados do contrato: não se passa `<T>`.

Mudar a assinatura de um lado sem mudar o contrato (ou mudar o contrato sem ajustar o outro lado) quebra o
`npm run typecheck`. Convenção de nomes: `<feature>:<ação>` para request/response e `<feature>:event:<nome>` para
eventos.

## Bus (main, entre features)

`bus` (`src/main/core/bus.ts`) é um `EventEmitter` em processo. Eventos: `store:changed` (core store),
`session:status`, `session:turn-ended`, `session:needs-input` e `session:file-written` (engine). Quem escuta o quê
está no comentário do arquivo. Use o bus para reagir a sessões; use o `api.ts` de outro feature para pedir algo a ele.

## Provedores

- **De system prompt** (`src/main/core/prompts.ts`): `registerSystemAppend(nome, (session) => texto)`. O engine
  anexa o que cada provedor devolve ao iniciar uma sessão; o harness usa isso para as lições do projeto.
- **De modelo** (`src/shared/providers.ts`): perfis (assinatura, Anthropic API, gateway, Bedrock, Vertex, Foundry)
  traduzidos em variáveis de ambiente do Claude Code. O segredo de cada perfil fica cifrado no main e nunca volta ao
  renderer.

## Plataforma Agent Hangar

O feature `platform` conecta o app à plataforma (contrato em `docs/platform/app-api-phase1.md`): login OAuth com
loopback (RFC 8252) e PKCE, tokens cifrados com refresh rotativo, registro e heartbeat do dispositivo e a política do
Windows (`HKLM`/`HKCU\Software\Policies\Hangar`: `PlatformUrl`, `Mode`). No modo `required` sem conexão, nenhuma
sessão é criada. Os tokens de design do app (`src/renderer/src/theme/tokens.json`) são uma cópia dos da plataforma
(`central/app/static/design-tokens.json`); `tests/unit/design-tokens.test.ts` mantém `styles.css` em sincronia.

## Qualidade

`npm run format:check` (Prettier), `npm run lint` (ESLint com type-check, incluindo a regra local
`hangar/effect-cleanup-only` para `useEffect`), `npm run typecheck`, `npm run typecheck:tests`, `npm test`
(Vitest) e `npm run test:e2e` (Playwright + Electron contra um servidor Anthropic falso). A CI
(`.github/workflows/ci.yml`) roda todos.
